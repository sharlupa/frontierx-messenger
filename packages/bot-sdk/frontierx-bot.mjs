// FrontierX Bot SDK: one file, no dependencies, Node.js 20 or newer.
//
//   import { FrontierXBot } from "./frontierx-bot.mjs"
//   const bot = new FrontierXBot({ token: process.env.FRONTIERX_BOT_TOKEN })
//   bot.command("start", (ctx) => ctx.reply("Hello, " + ctx.sender.displayName + "!"))
//   bot.on("text", (ctx) => ctx.reply("You said: " + ctx.text))
//   await bot.start()
//
// Chats with bots are end-to-end encrypted like every other chat. The SDK
// creates the bot's own identity key on first start and keeps it in a state
// file (keep that file private: it opens the bot's chats). Members hand the
// bot copies of their conversation keys, wrapped for that identity key; the
// server only ever relays ciphertext.

import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises"
import { basename, dirname, extname, resolve } from "node:path"
import { timingSafeEqual } from "node:crypto"

export const SDK_VERSION = "1.2.0"

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()
const CURVE = "P-256"

export const MEDIA_PREFIX = "fxmedia:1:"
export const LOCATION_PREFIX = "fxloc:1:"
export const CONTACT_PREFIX = "fxcontact:1:"
export const LINK_PREFIX = "fxlink:1:"
export const BUTTONS_PREFIX = "fxbtn:1:"

// --- encoding ---------------------------------------------------------------------

const toB64 = (bytes) => Buffer.from(bytes).toString("base64")
const fromB64 = (text) => new Uint8Array(Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64"))
const toB64Url = (bytes) => Buffer.from(bytes).toString("base64url")
const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length))

function concat(...parts) {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

// --- the same cryptography as the FrontierX apps ------------------------------------

const importPublic = (publicKey) => subtle.importKey("raw", fromB64(publicKey), { name: "ECDH", namedCurve: CURVE }, false, [])
const importPrivate = (privateKey) => subtle.importKey("pkcs8", fromB64(privateKey), { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"])
const importAes = (raw) => subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])

async function hkdfKey(ikm, salt, info, usages) {
	const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"])
	return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, usages)
}

async function generateIdentity() {
	const pair = await subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
	return {
		publicKey: toB64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))),
		privateKey: toB64(new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey))),
	}
}

async function eciesSeal(recipientPublicKey, plaintext, salt, info, aad) {
	const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
	const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await importPublic(recipientPublicKey) }, ephemeral.privateKey, 256))
	const key = await hkdfKey(shared, enc.encode(salt), info, ["encrypt"])
	const iv = randomBytes(12)
	const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, plaintext))
	return { ephemeralPublicKey: toB64(new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey))), iv: toB64(iv), ciphertext: toB64(sealed) }
}

async function eciesOpen(privateKey, payload, salt, info, aad) {
	const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: await importPublic(payload.ephemeralPublicKey) }, privateKey, 256))
	const key = await hkdfKey(shared, enc.encode(salt), info, ["decrypt"])
	return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromB64(payload.iv), additionalData: enc.encode(aad) }, key, fromB64(payload.ciphertext)))
}

// The first key of a chat ("legacy") keeps the wrapping of the original key
// system, so copies made by older app versions still open.
async function legacyKek(privateKey, publicKey, conversationId, usages) {
	const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
	const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
	return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("frontierx:" + conversationId), info: enc.encode("frontierx:cek-wrap") }, base, { name: "AES-GCM", length: 256 }, false, usages)
}

async function wrapShare(recipientPublicKey, conversationId, keyId, cek) {
	if (keyId === "legacy") {
		const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
		const kek = await legacyKek(ephemeral.privateKey, await importPublic(recipientPublicKey), conversationId, ["encrypt"])
		const iv = randomBytes(12)
		const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, kek, cek))
		return { ephemeralPublicKey: toB64(new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey))), iv: toB64(iv), ciphertext: toB64(sealed) }
	}
	return eciesSeal(recipientPublicKey, cek, "fx:share:" + conversationId + ":" + keyId, "fx:share:v2", "fx:share:v2:" + conversationId + ":" + keyId)
}

async function unwrapShare(privateKey, conversationId, keyId, share) {
	if (keyId === "legacy") {
		const kek = await legacyKek(privateKey, await importPublic(share.ephemeralPublicKey), conversationId, ["decrypt"])
		return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromB64(share.iv) }, kek, fromB64(share.ciphertext)))
	}
	return eciesOpen(privateKey, share, "fx:share:" + conversationId + ":" + keyId, "fx:share:v2", "fx:share:v2:" + conversationId + ":" + keyId)
}

async function cekCheck(cek, conversationId, keyId) {
	const iv = randomBytes(12)
	const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("fx:cek-check:v1:" + conversationId + ":" + keyId) }, await importAes(cek), enc.encode("frontierx-conversation-key")))
	return toB64(concat(iv, sealed))
}

async function verifyCek(cek, conversationId, keyId, check) {
	if (!check) return true
	try {
		const raw = fromB64(check)
		const opened = await subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode("fx:cek-check:v1:" + conversationId + ":" + keyId) }, await importAes(cek), raw.subarray(12))
		return dec.decode(opened) === "frontierx-conversation-key"
	} catch {
		return false
	}
}

function parseEnvelope(value) {
	if (typeof value !== "string") return null
	if (value.startsWith("fx1:")) return { version: 1, keyId: "legacy", body: value.slice(4) }
	if (value.startsWith("fx2:")) {
		const rest = value.slice(4)
		const sep = rest.indexOf(":")
		if (sep <= 0) return null
		return { version: 2, keyId: rest.slice(0, sep), body: rest.slice(sep + 1) }
	}
	return null
}

async function sealText(key, conversationId, keyId, plaintext) {
	const iv = randomBytes(12)
	const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("fx2|" + conversationId + "|" + keyId) }, key, enc.encode(plaintext)))
	return "fx2:" + keyId + ":" + toB64(concat(iv, sealed))
}

async function openText(key, conversationId, envelope) {
	const packed = fromB64(envelope.body)
	if (envelope.version === 1) {
		return dec.decode(await subtle.decrypt({ name: "AES-GCM", iv: packed.slice(1, 13) }, key, packed.slice(13)))
	}
	return dec.decode(await subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12), additionalData: enc.encode("fx2|" + conversationId + "|" + envelope.keyId) }, key, packed.slice(12)))
}

// --- message content ---------------------------------------------------------------

function parseJsonAfter(prefix, text) {
	if (typeof text !== "string" || !text.startsWith(prefix)) return null
	try {
		const value = JSON.parse(text.slice(prefix.length))
		return value && typeof value === "object" ? value : null
	} catch {
		return null
	}
}

function clean(value, max) {
	if (typeof value !== "string") return null
	const text = value.replace(/\s+/g, " ").trim()
	return text ? text.slice(0, max) : null
}

// What a decrypted message holds: plain text, an attachment, a place, a
// contact card or text with a link preview.
// Buttons under a message: rows of { text, data } (the press comes back to the
// bot as a callback) or { text, url } (opens an https link).
export function buttons(rows) {
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > 8) throw new Error("buttons: 1-8 rows")
	return rows.map((row) => {
		const list = Array.isArray(row) ? row : [row]
		if (list.length === 0 || list.length > 8) throw new Error("buttons: 1-8 buttons in a row")
		return list.map((button) => {
			const text = String(button?.text ?? "").replace(/\s+/g, " ").trim()
			if (!text || text.length > 64) throw new Error("button text: 1-64 characters")
			if (button.url !== undefined) {
				const url = new URL(String(button.url))
				if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("button url must be http(s)")
				return { text, url: url.toString() }
			}
			const data = String(button.data ?? "")
			if (!data || data.length > 256) throw new Error("button data: 1-256 characters")
			return { text, data }
		})
	})
}

export function describeContent(plaintext) {
	const withButtons = parseJsonAfter(BUTTONS_PREFIX, plaintext)
	if (withButtons && typeof withButtons.text === "string") return { kind: "text", text: withButtons.text, buttons: Array.isArray(withButtons.buttons) ? withButtons.buttons : [] }
	const media = parseJsonAfter(MEDIA_PREFIX, plaintext)
	if (media && typeof media.fileId === "string" && media.manifest) return { kind: "media", media, text: typeof media.caption === "string" ? media.caption : "" }
	const location = parseJsonAfter(LOCATION_PREFIX, plaintext)
	if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon))) {
		return { kind: "location", location: { lat: Number(location.lat), lon: Number(location.lon), accuracy: location.accuracy ?? null, label: clean(location.label, 120) }, text: "" }
	}
	const contact = parseJsonAfter(CONTACT_PREFIX, plaintext)
	if (contact && typeof contact.displayName === "string") return { kind: "contact", contact, text: "" }
	const link = parseJsonAfter(LINK_PREFIX, plaintext)
	if (link && typeof link.text === "string") return { kind: "text", text: link.text, linkPreview: link.preview ?? null }
	return { kind: "text", text: typeof plaintext === "string" ? plaintext : "" }
}

export function encodeLocation({ lat, lon, accuracy, label }) {
	const latN = Number(lat)
	const lonN = Number(lon)
	if (!Number.isFinite(latN) || !Number.isFinite(lonN) || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) throw new Error("lat/lon are out of range")
	const payload = { lat: Math.round(latN * 1e6) / 1e6, lon: Math.round(lonN * 1e6) / 1e6 }
	if (typeof accuracy === "number" && Number.isFinite(accuracy)) payload.accuracy = Math.round(accuracy)
	const place = clean(label, 120)
	if (place) payload.label = place
	return LOCATION_PREFIX + JSON.stringify(payload)
}

export function encodeContact({ displayName, userId, username, phone, email }) {
	const payload = { displayName: clean(displayName, 80) ?? "" }
	if (!payload.displayName) throw new Error("displayName is required")
	for (const [name, value, max] of [["userId", userId, 80], ["username", username, 40], ["phone", phone, 40], ["email", email, 120]]) {
		const text = clean(value, max)
		if (text) payload[name] = text
	}
	return CONTACT_PREFIX + JSON.stringify(payload)
}

// Formatting understood by the apps: *bold*, _italic_, ~strike~, `code`,
// ```blocks```, > quotes and ||spoilers||.
export const format = {
	bold: (text) => "*" + text + "*",
	italic: (text) => "_" + text + "_",
	strike: (text) => "~" + text + "~",
	code: (text) => "`" + text + "`",
	pre: (text) => "```\n" + text + "\n```",
	spoiler: (text) => "||" + text + "||",
	quote: (text) => String(text).split("\n").map((line) => "> " + line).join("\n"),
}


// --- attachments ------------------------------------------------------------------------
// The same format as the apps: the file is cut into chunks, each sealed with
// AES-256-GCM under a fresh file key (additional data "<fileId>:<index>"),
// and a manifest with a SHA-256 over its own fields lets the reader check it.

const MIN_CHUNK = 64 * 1024
const MAX_CHUNK = 4 * 1024 * 1024
const MAX_CHUNKS = 2048

function chunkSizeFor(size) {
	if (size <= MIN_CHUNK * MAX_CHUNKS) return MIN_CHUNK
	let chunk = MIN_CHUNK
	while (chunk < MAX_CHUNK && Math.ceil(size / chunk) > MAX_CHUNKS) chunk *= 2
	return chunk
}

async function encryptFile(rawKey, plaintext, fileId) {
	const key = await importAes(rawKey)
	const chunkSize = chunkSizeFor(plaintext.length)
	const chunkCount = Math.max(1, Math.ceil(plaintext.length / chunkSize))
	const chunks = []
	const parts = []
	for (let i = 0; i < chunkCount; i++) {
		const slice = plaintext.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plaintext.length))
		const iv = randomBytes(12)
		parts.push(new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(fileId + ":" + i) }, key, slice)))
		chunks.push({ index: i, iv: toB64(iv), length: slice.length })
	}
	const base = { version: 1, algo: "AES-256-GCM", fileId, size: plaintext.length, chunkSize, chunkCount, chunks }
	const manifestHash = toB64(new Uint8Array(await subtle.digest("SHA-256", enc.encode(JSON.stringify(base)))))
	return { cipher: concat(...parts), manifest: { ...base, manifestHash } }
}

const MIME_BY_EXT = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
	".pdf": "application/pdf", ".zip": "application/zip", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv",
	".conf": "text/plain", ".ovpn": "application/x-openvpn-profile",
}

function guessMime(name) {
	return MIME_BY_EXT[extname(String(name)).toLowerCase()] ?? "application/octet-stream"
}

// Width and height of PNG, GIF and JPEG images, so the chat reserves the right
// space before the photo loads.
function imageSize(bytes) {
	try {
		if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			return { width: view.getUint32(16), height: view.getUint32(20) }
		}
		if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
			return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
		}
		if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
			let offset = 2
			while (offset + 9 < bytes.length) {
				if (bytes[offset] !== 0xff) return null
				const marker = bytes[offset + 1]
				const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] }
				}
				offset += 2 + length
			}
		}
	} catch {
		// unknown layout: sent without a size
	}
	return null
}

async function readInput(input, options) {
	if (typeof input === "string") {
		const bytes = new Uint8Array(await readFile(input))
		return { bytes, name: options.name ?? basename(input) }
	}
	if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
		return { bytes: input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength), name: options.name ?? "file" }
	}
	throw new TypeError("send a file path, a Buffer or a Uint8Array")
}

// --- errors --------------------------------------------------------------------------

export class FrontierXError extends Error {
	constructor(status, message, data) {
		super(message)
		this.name = "FrontierXError"
		this.status = status
		this.data = data ?? null
	}
}

const sleep = (ms, signal) => new Promise((resolveSleep) => {
	const timer = setTimeout(resolveSleep, ms)
	signal?.addEventListener("abort", () => {
		clearTimeout(timer)
		resolveSleep()
	}, { once: true })
})

// --- the bot ---------------------------------------------------------------------------

export class FrontierXBot {
	constructor(options = {}) {
		const token = options.token ?? process.env.FRONTIERX_BOT_TOKEN
		if (!token || !/^fxb_[A-Za-z0-9_-]{20,80}$/.test(token)) throw new Error("a bot token (fxb_...) is required")
		this.token = token
		this.baseUrl = String(options.baseUrl ?? process.env.FRONTIERX_URL ?? "https://frontierx.zkito.fun").replace(/\/+$/, "")
		if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(this.baseUrl)) throw new Error("baseUrl must use https")
		this.stateFile = resolve(options.stateFile ?? process.env.FRONTIERX_BOT_STATE ?? "./frontierx-bot-state.json")
		this.logger = options.logger ?? console
		this.pollTimeout = Math.max(0, Math.min(50, options.pollTimeout ?? 45))
		this.handlers = new Map()
		this.commands = new Map()
		this.actions = []
		this.keys = new Map()
		this.pending = new Map()
		this.identity = null
		this.me = null
		this.offset = 0
		this.running = false
		this.abort = null
	}

	// --- events ---

	on(event, handler) {
		if (typeof handler !== "function") throw new TypeError("handler must be a function")
		const list = this.handlers.get(event) ?? []
		list.push(handler)
		this.handlers.set(event, list)
		return this
	}

	// Handles presses of buttons whose data matches: a string (exact) or a
	// RegExp (ctx.match holds the result).
	action(pattern, handler) {
		if (typeof handler !== "function") throw new TypeError("handler must be a function")
		this.actions.push({ pattern, handler })
		return this
	}

	command(name, handler) {
		const command = String(name).replace(/^\//, "").toLowerCase()
		if (!/^[a-z0-9_]{1,32}$/.test(command)) throw new Error("command names use a-z, 0-9 and _")
		this.commands.set(command, handler)
		return this
	}

	async emit(event, ctx) {
		const list = this.handlers.get(event)
		if (!list) return false
		for (const handler of list) {
			try {
				await handler(ctx)
			} catch (error) {
				if (event !== "error") await this.emit("error", { error, ctx })
				else this.logger.error("[frontierx-bot]", error)
			}
		}
		return true
	}

	// --- the HTTP API ---

	async call(method, name, payload) {
		let url = this.baseUrl + "/api/bot/v1/" + name
		const init = { method, headers: { authorization: "Bot " + this.token, "user-agent": "frontierx-bot-sdk/" + SDK_VERSION } }
		if (method === "GET" && payload) {
			const query = new URLSearchParams()
			for (const [key, value] of Object.entries(payload)) if (value !== undefined && value !== null) query.set(key, String(value))
			url += "?" + query.toString()
		} else if (payload) {
			init.headers["content-type"] = "application/json"
			init.body = JSON.stringify(payload)
		}
		if (this.abort && name === "getUpdates") init.signal = this.abort.signal
		const response = await fetch(url, init)
		if (name === "downloadFile") {
			if (!response.ok) throw new FrontierXError(response.status, "download failed")
			return new Uint8Array(await response.arrayBuffer())
		}
		let data = null
		try {
			data = await response.json()
		} catch {
			data = null
		}
		if (!response.ok || !data || data.ok === false) {
			throw new FrontierXError(response.status, (data && data.error) || "request failed (" + response.status + ")", data)
		}
		return data.result
	}

	// --- identity key ---

	async loadState() {
		try {
			const state = JSON.parse(await readFile(this.stateFile, "utf8"))
			if (state && state.identity && typeof state.identity.privateKey === "string") {
				this.identity = state.identity
				this.offset = Number(state.offset) || 0
			}
		} catch (error) {
			if (error && error.code !== "ENOENT") throw new Error("cannot read the state file " + this.stateFile + ": " + error.message)
		}
	}

	async saveState() {
		await mkdir(dirname(this.stateFile), { recursive: true })
		const temp = this.stateFile + ".tmp"
		await writeFile(temp, JSON.stringify({ identity: this.identity, offset: this.offset, sdk: SDK_VERSION }, null, "\t"), { mode: 0o600 })
		await rename(temp, this.stateFile)
		await chmod(this.stateFile, 0o600).catch(() => undefined)
	}

	async init() {
		if (this.me) return this.me
		await this.loadState()
		if (!this.identity) {
			this.identity = await generateIdentity()
			await this.saveState()
			this.logger.info?.("[frontierx-bot] created a new identity key in " + this.stateFile)
		}
		this.privateKey = await importPrivate(this.identity.privateKey)
		this.me = await this.call("GET", "getMe")
		if (this.me.publicKey !== this.identity.publicKey) {
			await this.call("POST", "setIdentityKey", { publicKey: this.identity.publicKey })
			this.me.publicKey = this.identity.publicKey
		}
		if (this.commands.size > 0) {
			const known = new Set((this.me.commands ?? []).map((item) => item.command))
			const missing = Array.from(this.commands.keys()).filter((name) => !known.has(name))
			if (missing.length > 0) {
				const merged = [...(this.me.commands ?? []), ...missing.map((command) => ({ command, description: "" }))]
				await this.call("POST", "setCommands", { commands: merged }).catch(() => undefined)
			}
		}
		return this.me
	}

	// --- conversation keys ---

	async loadKeys(conversationId, force = false) {
		const cached = this.keys.get(conversationId)
		if (cached && !force && Date.now() - cached.fetchedAt < 60000) return cached
		const result = await this.call("GET", "getKeys", { conversationId })
		const entry = cached ?? { ceks: new Map() }
		entry.currentKeyId = result.currentKeyId
		entry.rekeyNeeded = result.rekeyNeeded
		entry.epochs = new Map(result.epochs.map((epoch) => [epoch.keyId, epoch]))
		entry.members = result.members
		entry.shares = new Map(result.shares.map((share) => [share.keyId, share]))
		entry.missing = result.missing
		entry.fetchedAt = Date.now()
		this.keys.set(conversationId, entry)
		if (entry.missing.length > 0) void this.shareMissing(conversationId, entry).catch(() => undefined)
		return entry
	}

	async keyFor(conversationId, keyId) {
		let entry = await this.loadKeys(conversationId)
		if (entry.ceks.has(keyId)) return entry.ceks.get(keyId).key
		if (!entry.shares.has(keyId)) entry = await this.loadKeys(conversationId, true)
		const share = entry.shares.get(keyId)
		if (!share) return null
		if (share.recipientKey && share.recipientKey !== this.identity.publicKey) return null
		const raw = await unwrapShare(this.privateKey, conversationId, keyId, share)
		const epoch = entry.epochs.get(keyId)
		if (!(await verifyCek(raw, conversationId, keyId, epoch ? epoch.check : null))) throw new Error("the key copy for " + keyId + " does not match the chat's key")
		const key = await importAes(raw)
		entry.ceks.set(keyId, { key, raw })
		return key
	}

	async shareMissing(conversationId, entry) {
		const shares = []
		for (const item of entry.missing) {
			if (!item.publicKey) continue
			const held = entry.ceks.get(item.keyId) ?? (await this.keyFor(conversationId, item.keyId).then(() => entry.ceks.get(item.keyId)).catch(() => null))
			if (!held) continue
			shares.push({ keyId: item.keyId, memberId: item.memberId, recipientKey: item.publicKey, ...(await wrapShare(item.publicKey, conversationId, item.keyId, held.raw)) })
		}
		entry.missing = []
		if (shares.length > 0) await this.call("POST", "shareKeys", { conversationId, shares })
	}

	// Starts a new key when the chat has none or a member left.
	async mintKey(conversationId, entry) {
		const keyId = "k_" + toB64Url(randomBytes(12))
		const raw = randomBytes(32)
		const shares = []
		for (const member of entry.members) {
			if (!member.publicKey) continue
			shares.push({ memberId: member.userId, recipientKey: member.publicKey, ...(await wrapShare(member.publicKey, conversationId, keyId, raw)) })
		}
		await this.call("POST", "createKeyEpoch", { conversationId, keyId, expectedCurrentKeyId: entry.currentKeyId ?? null, check: await cekCheck(raw, conversationId, keyId), shares })
		entry.ceks.set(keyId, { key: await importAes(raw), raw })
		entry.currentKeyId = keyId
		entry.rekeyNeeded = false
		return keyId
	}

	async currentKey(conversationId, force = false) {
		const entry = await this.loadKeys(conversationId, force)
		if (!entry.currentKeyId || entry.rekeyNeeded) {
			try {
				const keyId = await this.mintKey(conversationId, entry)
				return { keyId, key: entry.ceks.get(keyId).key }
			} catch (error) {
				if (error instanceof FrontierXError && error.status === 409) return this.currentKey(conversationId, true)
				throw error
			}
		}
		const key = await this.keyFor(conversationId, entry.currentKeyId)
		if (!key) throw new FrontierXError(423, "the bot has no copy of this chat's key yet; a member's app hands it over shortly")
		return { keyId: entry.currentKeyId, key }
	}

	// Seals with the chat's current key; if the key changed meanwhile the
	// server refuses and the message is sealed again with the new one.
	async sealAndCall(name, conversationId, plaintext, extra) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const { keyId, key } = await this.currentKey(conversationId, attempt > 0)
			const ciphertext = await sealText(key, conversationId, keyId, plaintext)
			try {
				return await this.call("POST", name, { conversationId, ciphertext, ...extra })
			} catch (error) {
				if (error instanceof FrontierXError && error.status === 409 && /key changed/.test(error.message)) continue
				throw error
			}
		}
		throw new FrontierXError(409, "the conversation key keeps changing; try again")
	}

	async decrypt(conversationId, ciphertext) {
		const envelope = parseEnvelope(ciphertext)
		if (!envelope) return typeof ciphertext === "string" ? ciphertext : ""
		const key = await this.keyFor(conversationId, envelope.keyId)
		if (!key) return null
		return openText(key, conversationId, envelope)
	}

	// --- sending ---

	sendText(conversationId, text, options = {}) {
		const body = String(text ?? "")
		if (!body.trim()) throw new Error("text is empty")
		if (body.length > 16000) throw new Error("text is too long (16000 characters at most)")
		const plaintext = options.buttons ? BUTTONS_PREFIX + JSON.stringify({ text: body, buttons: buttons(options.buttons) }) : body
		return this.sealAndCall("sendMessage", conversationId, plaintext, { replyTo: options.replyTo ?? null, silent: options.silent === true })
	}

	sendLocation(conversationId, location, options = {}) {
		return this.sealAndCall("sendMessage", conversationId, encodeLocation(location), { replyTo: options.replyTo ?? null, silent: options.silent === true })
	}

	sendContact(conversationId, contact, options = {}) {
		return this.sealAndCall("sendMessage", conversationId, encodeContact(contact), { replyTo: options.replyTo ?? null, silent: options.silent === true })
	}

	// Replaces the text (and the buttons: pass options.buttons to keep or
	// change them; without it the buttons go away).
	editText(conversationId, messageId, text, options = {}) {
		const body = String(text ?? "")
		const plaintext = options.buttons ? BUTTONS_PREFIX + JSON.stringify({ text: body, buttons: buttons(options.buttons) }) : body
		return this.sealAndCall("editMessage", conversationId, plaintext, { messageId })
	}

	// Answers a button press: an optional short notice for the person who
	// pressed it (a toast, or a dialog with { alert: true }).
	async answerCallback(conversationId, callbackId, text, options = {}) {
		let sealed = null
		if (text) {
			const { keyId, key } = await this.currentKey(conversationId)
			sealed = await sealText(key, conversationId, keyId, String(text).slice(0, 1000))
		}
		return this.call("POST", "answerCallback", { callbackId, text: sealed, alert: options.alert === true })
	}

	deleteMessage(conversationId, messageId) {
		return this.call("POST", "deleteMessage", { conversationId, messageId })
	}

	sendTyping(conversationId) {
		return this.call("POST", "sendTyping", { conversationId })
	}

	leave(conversationId) {
		this.keys.delete(conversationId)
		return this.call("POST", "leaveConversation", { conversationId })
	}

	setCommands(commands) {
		return this.call("POST", "setCommands", { commands })
	}

	getConversations() {
		return this.call("GET", "getConversations")
	}

	getConversation(conversationId) {
		return this.call("GET", "getConversation", { conversationId })
	}

	// Sends a file (a path, a Buffer or a Uint8Array). Photos show as photos,
	// videos play in the chat, anything else arrives as a file.
	// options: name, mime, caption, spoiler, replyTo, silent, width, height,
	// duration (seconds, videos), poster (small JPEG data URL, videos).
	async sendFile(conversationId, input, options = {}) {
		const { bytes, name: rawName } = await readInput(input, options)
		const name = String(rawName).replace(/[\\/]/g, "_").slice(0, 255) || "file"
		const mime = String(options.mime ?? guessMime(name)).slice(0, 127)
		if (bytes.length === 0) throw new Error("the file is empty")
		const { keyId, key } = await this.currentKey(conversationId)
		const created = await this.call("POST", "createFile", {
			conversationId,
			name: await sealText(key, conversationId, keyId, name),
			mime: await sealText(key, conversationId, keyId, mime),
			size: bytes.length,
		})
		const rawKey = randomBytes(32)
		const { cipher, manifest } = await encryptFile(rawKey, bytes, created.fileId)
		await this.upload(created.fileId, cipher)
		const envelope = { kind: mime.startsWith("image/") ? "image" : "file", fileId: created.fileId, name, mime, size: bytes.length, key: toB64(rawKey), manifest }
		const size = mime.startsWith("image/") ? imageSize(bytes) : null
		if (options.width && options.height) Object.assign(envelope, { width: Number(options.width), height: Number(options.height) })
		else if (size && size.width > 0 && size.height > 0) Object.assign(envelope, size)
		if (options.duration) envelope.duration = Number(options.duration)
		if (typeof options.poster === "string" && options.poster.startsWith("data:image/")) envelope.poster = options.poster
		if (options.caption) envelope.caption = String(options.caption).slice(0, 4096)
		if (options.spoiler && (mime.startsWith("image/") || mime.startsWith("video/"))) envelope.spoiler = true
		if (options.buttons) envelope.buttons = buttons(options.buttons)
		return this.sealAndCall("sendMessage", conversationId, MEDIA_PREFIX + JSON.stringify(envelope), { replyTo: options.replyTo ?? null, silent: options.silent === true })
	}

	sendPhoto(conversationId, input, options = {}) {
		const mime = options.mime ?? (typeof input === "string" ? guessMime(input) : "image/jpeg")
		if (!String(mime).startsWith("image/")) throw new Error("sendPhoto takes an image (jpg, png, gif, webp)")
		return this.sendFile(conversationId, input, { name: "photo" + (mime === "image/png" ? ".png" : mime === "image/gif" ? ".gif" : mime === "image/webp" ? ".webp" : ".jpg"), ...options, mime })
	}

	sendVideo(conversationId, input, options = {}) {
		const mime = options.mime ?? (typeof input === "string" ? guessMime(input) : "video/mp4")
		if (!String(mime).startsWith("video/")) throw new Error("sendVideo takes a video (mp4, mov, webm)")
		return this.sendFile(conversationId, input, { name: "video" + (mime === "video/webm" ? ".webm" : mime === "video/quicktime" ? ".mov" : ".mp4"), ...options, mime })
	}

	sendDocument(conversationId, input, options = {}) {
		return this.sendFile(conversationId, input, options)
	}

	async upload(fileId, bytes) {
		const response = await fetch(this.baseUrl + "/api/bot/v1/uploadFile?fileId=" + encodeURIComponent(fileId), {
			method: "POST",
			headers: { authorization: "Bot " + this.token, "content-type": "application/octet-stream", "user-agent": "frontierx-bot-sdk/" + SDK_VERSION },
			body: bytes,
		})
		let data = null
		try {
			data = await response.json()
		} catch {
			data = null
		}
		if (!response.ok || !data || data.ok === false) throw new FrontierXError(response.status, (data && data.error) || "upload failed (" + response.status + ")", data)
		return data.result
	}

	// Downloads an attachment and decrypts it: returns the file's bytes.
	async downloadMedia(media) {
		if (!media || typeof media.fileId !== "string" || !media.manifest || typeof media.key !== "string") throw new Error("not an attachment")
		const manifest = media.manifest
		const { manifestHash, ...base } = manifest
		const expected = toB64(new Uint8Array(await subtle.digest("SHA-256", enc.encode(JSON.stringify(base)))))
		if (expected !== manifestHash || manifest.chunkCount !== manifest.chunks.length) throw new Error("the attachment's manifest is invalid")
		const cipher = await this.call("GET", "downloadFile", { fileId: media.fileId })
		const key = await importAes(fromB64(media.key))
		const out = new Uint8Array(manifest.size)
		let offset = 0
		let written = 0
		for (let i = 0; i < manifest.chunkCount; i++) {
			const meta = manifest.chunks[i]
			const length = meta.length + 16
			const sealed = cipher.subarray(offset, offset + length)
			if (sealed.length !== length) throw new Error("the attachment is truncated")
			offset += length
			const opened = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromB64(meta.iv), additionalData: enc.encode(manifest.fileId + ":" + i) }, key, sealed))
			out.set(opened, written)
			written += opened.length
		}
		return out
	}

	// --- updates ---

	async handleUpdate(update) {
		if (!update || typeof update !== "object") return
		switch (update.type) {
			case "message":
			case "message_edited":
				await this.handleMessage(update)
				break
			case "callback":
				await this.handleCallback(update)
				break
			case "message_deleted":
				await this.emit("deleted", { bot: this, update, conversationId: update.conversationId, messageId: update.messageId })
				break
			case "conversation_added":
				this.keys.delete(update.conversation?.id)
				await this.emit("conversation", { bot: this, update, conversationId: update.conversation?.id, conversation: update.conversation, by: update.addedBy ?? update.startedBy ?? null, send: (text, options) => this.sendText(update.conversation.id, text, options) })
				break
			case "keys_updated": {
				const entry = this.keys.get(update.conversationId)
				if (entry) entry.fetchedAt = 0
				await this.retryPending(update.conversationId)
				break
			}
			default:
				await this.emit("update", { bot: this, update })
		}
	}

	async handleMessage(update) {
		const conversationId = update.conversationId
		const message = update.message
		if (!message || message.senderId === this.me?.id) return
		let plaintext
		try {
			plaintext = message.deletedAt ? null : await this.decrypt(conversationId, message.ciphertext)
		} catch (error) {
			await this.emit("error", { error, update })
			return
		}
		if (plaintext === null) {
			if (!message.deletedAt) this.queuePending(conversationId, update)
			return
		}
		const content = describeContent(plaintext)
		const ctx = {
			bot: this,
			update,
			conversationId,
			conversation: update.conversation ?? null,
			message,
			sender: update.sender ?? { id: message.senderId },
			edited: update.type === "message_edited",
			...content,
			buttons: content.buttons ?? content.media?.buttons ?? null,
			reply: (text, options = {}) => this.sendText(conversationId, text, { ...options, replyTo: message.id }),
			send: (text, options) => this.sendText(conversationId, text, options),
			typing: () => this.sendTyping(conversationId),
			download: () => (content.media ? this.downloadMedia(content.media) : Promise.reject(new Error("the message has no attachment"))),
			replyWithFile: (input, options = {}) => this.sendFile(conversationId, input, { ...options, replyTo: message.id }),
			replyWithPhoto: (input, options = {}) => this.sendPhoto(conversationId, input, { ...options, replyTo: message.id }),
			replyWithVideo: (input, options = {}) => this.sendVideo(conversationId, input, { ...options, replyTo: message.id }),
		}
		if (ctx.edited) {
			await this.emit("edited", ctx)
			return
		}
		const match = content.kind === "text" ? /^\/([a-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(content.text.trim()) : null
		if (match) {
			ctx.command = match[1].toLowerCase()
			ctx.args = (match[2] ?? "").trim()
			const handler = this.commands.get(ctx.command)
			if (handler) {
				try {
					await handler(ctx)
				} catch (error) {
					await this.emit("error", { error, ctx })
				}
				return
			}
		}
		await this.emit(content.kind, ctx)
		await this.emit("message", ctx)
	}

	async handleCallback(update) {
		const conversationId = update.conversationId
		let data
		try {
			data = await this.decrypt(conversationId, update.data)
		} catch (error) {
			await this.emit("error", { error, update })
			return
		}
		if (data === null) return
		let answered = false
		const ctx = {
			bot: this,
			update,
			callbackId: update.callbackId,
			conversationId,
			messageId: update.messageId,
			from: update.from ?? null,
			sender: update.from ?? null,
			data,
			match: null,
			answer: async (text, options) => {
				if (answered) return
				answered = true
				await this.answerCallback(conversationId, update.callbackId, text, options)
			},
			edit: (text, options) => this.editText(conversationId, update.messageId, text, options),
			reply: (text, options = {}) => this.sendText(conversationId, text, { ...options, replyTo: update.messageId }),
			send: (text, options) => this.sendText(conversationId, text, options),
		}
		const action = this.actions.find(({ pattern }) => (pattern instanceof RegExp ? pattern.test(data) : pattern === data))
		try {
			if (action) {
				if (action.pattern instanceof RegExp) ctx.match = action.pattern.exec(data)
				await action.handler(ctx)
			} else {
				await this.emit("callback", ctx)
			}
		} catch (error) {
			await this.emit("error", { error, ctx })
		}
		// The button stops spinning once the bot has handled the press.
		if (!answered) await ctx.answer().catch(() => undefined)
	}

	// A message that arrived before its key: kept for ten minutes and tried
	// again when keys for its chat arrive.
	queuePending(conversationId, update) {
		const list = this.pending.get(conversationId) ?? []
		list.push({ update, at: Date.now() })
		while (list.length > 100) list.shift()
		this.pending.set(conversationId, list)
	}

	async retryPending(conversationId) {
		const list = this.pending.get(conversationId)
		if (!list || list.length === 0) return
		this.pending.delete(conversationId)
		const fresh = list.filter((item) => Date.now() - item.at < 600000)
		for (const item of fresh) await this.handleMessage(item.update)
	}

	// Long polling. Updates are acknowledged by asking for the next offset, so
	// one is only dropped after the handler for it has finished.
	async start() {
		await this.init()
		this.running = true
		this.abort = new AbortController()
		this.logger.info?.("[frontierx-bot] @" + this.me.username + " is running")
		let delay = 1000
		let sweep = Date.now()
		while (this.running) {
			try {
				const updates = await this.call("GET", "getUpdates", { offset: this.offset, timeout: this.pollTimeout })
				delay = 1000
				for (const update of updates) {
					await this.handleUpdate(update)
					this.offset = update.updateId + 1
				}
				if (updates.length > 0) await this.saveState()
				if (Date.now() - sweep > 30000) {
					sweep = Date.now()
					for (const conversationId of Array.from(this.pending.keys())) {
						const entry = this.keys.get(conversationId)
						if (entry) entry.fetchedAt = 0
						await this.retryPending(conversationId)
					}
				}
			} catch (error) {
				if (!this.running) break
				if (error instanceof FrontierXError && error.status === 401) {
					this.logger.error("[frontierx-bot] the token was rejected; stopping")
					this.running = false
					break
				}
				if (error instanceof FrontierXError && error.status === 409) {
					this.logger.error("[frontierx-bot] a webhook is set for this bot; call deleteWebhook to use polling")
					this.running = false
					break
				}
				await this.emit("error", { error })
				await sleep(delay, this.abort.signal)
				delay = Math.min(delay * 2, 30000)
			}
		}
	}

	stop() {
		this.running = false
		this.abort?.abort()
	}

	// For bots that receive updates by webhook: a node:http handler that checks
	// the secret header and runs the update.
	webhookHandler(secret) {
		const expected = Buffer.from(String(secret ?? ""))
		return async (req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405).end()
				return
			}
			const given = Buffer.from(String(req.headers["x-frontierx-bot-secret"] ?? ""))
			if (expected.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
				res.writeHead(401).end()
				return
			}
			const chunks = []
			let size = 0
			for await (const chunk of req) {
				size += chunk.length
				if (size > 1024 * 1024) {
					res.writeHead(413).end()
					return
				}
				chunks.push(chunk)
			}
			let update
			try {
				update = JSON.parse(Buffer.concat(chunks).toString("utf8"))
			} catch {
				res.writeHead(400).end()
				return
			}
			try {
				await this.init()
				await this.handleUpdate(update)
				res.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}")
			} catch (error) {
				await this.emit("error", { error, update })
				res.writeHead(500).end()
			}
		}
	}

	setWebhook(url, secret) {
		return this.call("POST", "setWebhook", { url, secret })
	}

	deleteWebhook() {
		return this.call("POST", "deleteWebhook")
	}
}

export default FrontierXBot
