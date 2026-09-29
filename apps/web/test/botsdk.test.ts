import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startTestServer } from "../../api/test/helpers"
import { api, setApiBase } from "../src/lib/api"
import { setSession, getDeviceId } from "../src/lib/session"
import { addIdentities } from "../src/lib/keystore"
import * as kv from "../src/lib/keyvault"
import { Keyring } from "../src/lib/keyring"
import { setupKeys } from "../src/lib/accountKeys"
import { parseLocation } from "../src/lib/richmsg"
import { encodeMediaMessage, packFile, parseMediaMessage, unpackFile } from "../src/lib/media"
import { parseButtonMessage, sanitizeButtons } from "../src/lib/botmsg"
// @ts-expect-error plain JavaScript module
import { FrontierXBot } from "../../../packages/bot-sdk/frontierx-bot.mjs"

// The bot SDK against a real API and the web app's own key code: a person and
// a bot talk end to end encrypted, both ways.

class Device {
	private data = new Map<string, string>()
	use(): void {
		const data = this.data
		;(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
			setItem: (key: string, value: string) => void data.set(key, String(value)),
			removeItem: (key: string) => void data.delete(key),
			key: (index: number) => Array.from(data.keys())[index] ?? null,
			get length() {
				return data.size
			},
			clear: () => data.clear(),
		}
	}
}

;(globalThis as Record<string, unknown>).window = globalThis

const quiet = { info: () => undefined, error: () => undefined, warn: () => undefined }

async function pump(bot: { call: (method: string, name: string, payload?: unknown) => Promise<Array<{ updateId: number }>>; handleUpdate: (update: unknown) => Promise<void>; offset: number }): Promise<number> {
	const updates = await bot.call("GET", "getUpdates", { offset: bot.offset, timeout: 0 })
	for (const update of updates) {
		await bot.handleUpdate(update)
		bot.offset = update.updateId + 1
	}
	return updates.length
}

test("bot SDK: encrypted chat with a person, commands, places, a new bot key", async (t) => {
	const s = await startTestServer()
	const dir = await mkdtemp(join(tmpdir(), "fx-bot-"))
	t.after(async () => {
		s.close()
		await rm(dir, { recursive: true, force: true })
	})
	setApiBase(s.base)

	const phone = new Device()
	phone.use()
	const identity = await kv.generateIdentity()
	const reg = await api.register({ username: "maria", password: "maria-password", displayName: "Maria", publicKey: identity.publicKey, deviceId: getDeviceId() })
	addIdentities(reg.user.id, [identity])
	setSession(reg.token, reg.user)
	const setup = await setupKeys(reg.user.id, "maria-password")
	assert.equal(setup.status, "ready")
	if (setup.status !== "ready") return
	const ring = new Keyring(setup.session)

	const created = await api.createBot({ username: "echo_bot", displayName: "Echo" })
	const stateFile = join(dir, "state.json")
	const bot = new FrontierXBot({ token: created.token, baseUrl: s.base, stateFile, logger: quiet })
	const seen: string[] = []
	bot.command("start", async (ctx: { args: string; reply: (text: string) => Promise<unknown>; sender: { displayName: string } }) => {
		await ctx.reply("hello " + ctx.sender.displayName + " " + ctx.args)
	})
	bot.on("text", async (ctx: { text: string; reply: (text: string) => Promise<unknown> }) => {
		seen.push(ctx.text)
		await ctx.reply("echo: " + ctx.text)
	})
	bot.on("location", async (ctx: { location: { lat: number; lon: number }; send: (text: string) => Promise<unknown>; conversationId: string }) => {
		await bot.sendLocation(ctx.conversationId, { lat: ctx.location.lat + 1, lon: ctx.location.lon, label: "Near you" })
	})
	const me = await bot.init()
	assert.equal(me.username, "echo_bot")
	// The identity key lives only in the state file, readable by the owner alone.
	assert.equal((await stat(stateFile)).mode & 0o077, 0)

	// Starting the bot opens a chat at once.
	phone.use()
	const started = await api.sendFriendRequest("echo_bot")
	const chat = (started.conversation as { id: string }).id
	assert.ok(chat)

	phone.use()
	await ring.sealAndSend(chat, "/start friend", (ciphertext) => api.sendMessage(chat, { ciphertext }))
	await ring.sealAndSend(chat, "how are you?", (ciphertext) => api.sendMessage(chat, { ciphertext }))
	const where = "fxloc:1:" + JSON.stringify({ lat: 55.75, lon: 37.61 })
	await ring.sealAndSend(chat, where, (ciphertext) => api.sendMessage(chat, { ciphertext }))
	assert.ok((await pump(bot)) >= 3)
	assert.deepEqual(seen, ["how are you?"])

	// The server only ever held ciphertext.
	const raw = s.app.store.listMessages(chat, { limit: 50 })
	assert.ok(raw.length >= 6)
	for (const row of raw) assert.match(row.ciphertext, /^fx2:/)

	phone.use()
	const listed = await api.listMessages(chat, { limit: 50 })
	const texts: string[] = []
	for (const message of listed.messages) texts.push(await ring.decrypt(chat, message.ciphertext))
	assert.ok(texts.includes("hello Maria friend"), texts.join(" | "))
	assert.ok(texts.includes("echo: how are you?"))
	const place = texts.map((text) => parseLocation(text)).find((value) => value && value.label === "Near you")
	assert.ok(place)
	assert.equal(place?.lat, 56.75)

	// The bot loses its state file: a new identity key. The person's app hands
	// the chat key over again and the conversation goes on.
	await rm(stateFile)
	const again = new FrontierXBot({ token: created.token, baseUrl: s.base, stateFile, logger: quiet })
	const replies: string[] = []
	again.on("text", async (ctx: { text: string; reply: (text: string) => Promise<unknown> }) => {
		replies.push(ctx.text)
		await ctx.reply("still here")
	})
	await again.init()
	again.offset = bot.offset
	phone.use()
	await ring.sealAndSend(chat, "after the reset", (ciphertext) => api.sendMessage(chat, { ciphertext }))
	await pump(again)
	assert.deepEqual(replies, [], "no key yet, the message waits")
	phone.use()
	await ring.syncPending()
	await pump(again)
	await new Promise((resolveWait) => setTimeout(resolveWait, 50))
	assert.deepEqual(replies, ["after the reset"])
	phone.use()
	const last = (await api.listMessages(chat, { limit: 50 })).messages.at(-1)
	assert.ok(last)
	assert.equal(await ring.decrypt(chat, last.ciphertext), "still here")
})

test("bot SDK: files, photos and videos both ways, end to end", async (t) => {
	const s = await startTestServer()
	const dir = await mkdtemp(join(tmpdir(), "fx-bot-files-"))
	t.after(async () => {
		s.close()
		await rm(dir, { recursive: true, force: true })
	})
	setApiBase(s.base)
	const phone = new Device()
	phone.use()
	const identity = await kv.generateIdentity()
	const reg = await api.register({ username: "oleg", password: "oleg-password", displayName: "Oleg", publicKey: identity.publicKey, deviceId: getDeviceId() })
	addIdentities(reg.user.id, [identity])
	setSession(reg.token, reg.user)
	const setup = await setupKeys(reg.user.id, "oleg-password")
	if (setup.status !== "ready") throw new Error("locked")
	const ring = new Keyring(setup.session)
	const created = await api.createBot({ username: "files_bot", displayName: "Files" })
	const bot = new FrontierXBot({ token: created.token, baseUrl: s.base, stateFile: join(dir, "state.json"), logger: quiet })
	const received: Uint8Array[] = []
	bot.on("media", async (ctx: { download: () => Promise<Uint8Array>; media: { name: string } }) => {
		received.push(await ctx.download())
	})
	await bot.init()
	phone.use()
	const chat = ((await api.sendFriendRequest("files_bot")).conversation as { id: string }).id

	// A person sends a file to the bot: the bot decrypts the same bytes.
	const original = new TextEncoder().encode("vless://example-config#FrontierX")
	const upload = await api.createFile({ conversationId: chat, name: "sealed", mime: "sealed", size: original.length })
	const packed = await packFile(upload.asset.id, "config.txt", "text/plain", original)
	// (the app uploads with XMLHttpRequest for progress; plain fetch here)
	await fetch(s.base + "/api/files/" + upload.asset.id + "/blob", { method: "POST", headers: { authorization: "Bearer " + reg.token, "content-type": "application/octet-stream" }, body: packed.cipher })
	await ring.sealAndSend(chat, encodeMediaMessage(packed.envelope), (ciphertext) => api.sendMessage(chat, { ciphertext }))
	await pump(bot)
	assert.equal(received.length, 1)
	assert.deepEqual(Array.from(received[0]), Array.from(original))

	// The bot sends a photo (a 3x2 PNG), a large video and a document.
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 1, 2, 3, 4])
	await bot.sendPhoto(chat, png, { caption: "Схема подключения", spoiler: true })
	const video = new Uint8Array(300 * 1024).map((_v, i) => i % 251)
	await bot.sendVideo(chat, video, { duration: 3 })
	const docPath = join(dir, "manual.pdf")
	await writeFile(docPath, "%PDF-1.4 test")
	await bot.sendFile(chat, docPath)

	phone.use()
	const messages = (await api.listMessages(chat, { limit: 50 })).messages.filter((m) => m.senderId !== reg.user.id)
	const media = []
	for (const message of messages) {
		const plain = await ring.decrypt(chat, message.ciphertext)
		const envelope = parseMediaMessage(plain)
		if (envelope) media.push(envelope)
	}
	assert.equal(media.length, 3)
	const [photo, clip, doc] = media
	assert.equal(photo.kind, "image")
	assert.equal(photo.width, 3)
	assert.equal(photo.height, 2)
	assert.equal(photo.caption, "Схема подключения")
	assert.equal(photo.spoiler, true)
	assert.equal(clip.mime, "video/mp4")
	assert.equal(clip.duration, 3)
	assert.ok(clip.manifest.chunkCount > 1)
	assert.equal(doc.name, "manual.pdf")
	assert.equal(doc.mime, "application/pdf")
	for (const [envelope, bytes] of [[photo, png], [clip, video], [doc, new TextEncoder().encode("%PDF-1.4 test")]] as const) {
		const cipher = await api.downloadFileBlob(envelope.fileId)
		assert.deepEqual(Array.from(await unpackFile(envelope, cipher)), Array.from(bytes))
	}
	// The server keeps the name and type sealed, never in the clear.
	const stored = s.app.store.getFileAsset(doc.fileId)
	assert.ok(stored)
	assert.equal(stored.name.includes("manual"), false)
	assert.equal(stored.mime.includes("pdf"), false)
})

test("bot SDK: buttons under messages, presses and answers", async (t) => {
	const s = await startTestServer()
	const dir = await mkdtemp(join(tmpdir(), "fx-bot-buttons-"))
	t.after(async () => {
		s.close()
		await rm(dir, { recursive: true, force: true })
	})
	setApiBase(s.base)
	const phone = new Device()
	phone.use()
	const identity = await kv.generateIdentity()
	const reg = await api.register({ username: "nina", password: "nina-password", displayName: "Nina", publicKey: identity.publicKey, deviceId: getDeviceId() })
	addIdentities(reg.user.id, [identity])
	setSession(reg.token, reg.user)
	const setup = await setupKeys(reg.user.id, "nina-password")
	if (setup.status !== "ready") throw new Error("locked")
	const ring = new Keyring(setup.session)
	const created = await api.createBot({ username: "shop_bot", displayName: "Shop" })
	const bot = new FrontierXBot({ token: created.token, baseUrl: s.base, stateFile: join(dir, "state.json"), logger: quiet })
	const pressed: Array<{ data: string; from: string; match: string | null }> = []
	bot.action(/^buy:(month|year)$/, async (ctx: { data: string; from: { username: string }; match: RegExpExecArray | null; answer: (text: string) => Promise<void>; edit: (text: string, options?: unknown) => Promise<unknown> }) => {
		pressed.push({ data: ctx.data, from: ctx.from.username, match: ctx.match ? ctx.match[1] : null })
		await ctx.answer("Оплата: " + ctx.match?.[1])
		await ctx.edit("Счёт на " + ctx.match?.[1] + " выставлен", { buttons: [[{ text: "Оплатить", url: "https://pay.example.com/invoice/1" }]] })
	})
	await bot.init()
	phone.use()
	const chat = ((await api.sendFriendRequest("shop_bot")).conversation as { id: string }).id
	const sent = await bot.sendText(chat, "Выберите тариф", { buttons: [[{ text: "Месяц", data: "buy:month" }, { text: "Год", data: "buy:year" }], [{ text: "Сайт", url: "https://example.com" }]] })
	assert.throws(() => bot.sendText(chat, "x", { buttons: [[{ text: "bad", url: "javascript:alert(1)" }]] }))

	// The app sees the text and the buttons.
	phone.use()
	const first = (await api.listMessages(chat, { limit: 10 })).messages.find((m) => m.id === sent.id)
	assert.ok(first)
	const parsed = parseButtonMessage(await ring.decrypt(chat, first.ciphertext))
	assert.ok(parsed)
	assert.equal(parsed.text, "Выберите тариф")
	assert.deepEqual(parsed.buttons.map((row) => row.map((b) => b.text)), [["Месяц", "Год"], ["Сайт"]])
	// Unsafe or malformed buttons from anyone are dropped by the app.
	assert.deepEqual(sanitizeButtons([[{ text: "x", url: "javascript:alert(1)" }, { text: "", data: "a" }, { text: "ok", data: "go" }]]), [[{ text: "ok", data: "go" }]])

	// Pressing "Год": the data travels sealed, the bot gets it and answers.
	const sealed = await ring.encrypt(chat, "buy:year")
	const press = await api.botCallback(chat, sent.id, sealed)
	assert.match(press.callbackId, /^cb_/)
	await pump(bot)
	assert.deepEqual(pressed, [{ data: "buy:year", from: "nina", match: "year" }])
	phone.use()
	const edited = (await api.listMessages(chat, { limit: 10 })).messages.find((m) => m.id === sent.id)
	assert.ok(edited)
	const after = parseButtonMessage(await ring.decrypt(chat, edited.ciphertext))
	assert.equal(after?.text, "Счёт на year выставлен")
	assert.equal(after?.buttons[0][0].url, "https://pay.example.com/invoice/1")
	// A press is answered only once.
	assert.equal((await fetch(s.base + "/api/bot/v1/answerCallback", { method: "POST", headers: { authorization: "Bot " + created.token, "content-type": "application/json" }, body: JSON.stringify({ callbackId: press.callbackId }) })).status, 404)
})
