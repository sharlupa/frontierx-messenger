import { test } from "node:test"
import assert from "node:assert/strict"
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes, verify, createPublicKey } from "node:crypto"
import { api, directConversation, registerUser, startTestServer } from "./helpers"
import { encryptPayload, vapidAuthorization, loadVapidKeys } from "../src/webpush"

test("silent messages carry the flag and skip nothing else", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a, b, cid } = await directConversation(s.base, "silenta", "silentb")
  const events: any[] = []
  t.after(s.app.bus.subscribeUser(b.user.id, (event) => events.push(event)))
  const sent = await api(s.base, `/api/conversations/${cid}/messages`, { token: a.token, body: { ciphertext: "psst", silent: true } })
  assert.equal(sent.json.message.silent, true)
  assert.equal(events.find((e) => e.type === "message.created").message.silent, true)
  const loud = await api(s.base, `/api/conversations/${cid}/messages`, { token: a.token, body: { ciphertext: "hey" } })
  assert.equal(loud.json.message.silent, undefined)
  const history = await api(s.base, `/api/conversations/${cid}/messages`, { token: b.token })
  assert.deepEqual(history.json.messages.map((m: { silent?: boolean }) => Boolean(m.silent)), [true, false])
})

test("scheduled messages stay private and go out on time", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a, b, cid } = await directConversation(s.base, "scheda", "schedb")
  const soon = new Date(Date.now() + 60000).toISOString()
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token, body: { ciphertext: "later", sendAt: new Date(Date.now() - 1000).toISOString() } })).status, 400)
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token, body: { ciphertext: "later", sendAt: new Date(Date.now() + 400 * 86400000).toISOString() } })).status, 400)
  const created = await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token, body: { ciphertext: "later", sendAt: soon, silent: true } })
  assert.equal(created.status, 201)
  const sid = created.json.scheduled.id as string

  // Only the sender sees it before it goes out.
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token })).json.scheduled.length, 1)
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled`, { token: b.token })).json.scheduled.length, 0)
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled/${sid}/delete`, { token: b.token, body: {} })).status, 404)
  assert.equal((await api(s.base, `/api/conversations/${cid}/messages`, { token: b.token })).json.messages.length, 0)
  const list = await api(s.base, "/api/conversations", { token: a.token })
  assert.equal(list.json.conversations.find((c: { id: string }) => c.id === cid).scheduledCount, 1)

  const moved = new Date(Date.now() + 120000).toISOString()
  const edited = await api(s.base, `/api/conversations/${cid}/scheduled/${sid}/update`, { token: a.token, body: { sendAt: moved, ciphertext: "later-edited" } })
  assert.equal(edited.json.scheduled.sendAt, moved)

  assert.equal(s.app.deliverDueScheduled(Date.now()), 0)
  assert.equal(s.app.deliverDueScheduled(Date.now() + 121000), 1)
  const delivered = await api(s.base, `/api/conversations/${cid}/messages`, { token: b.token })
  assert.equal(delivered.json.messages.length, 1)
  assert.equal(delivered.json.messages[0].ciphertext, "later-edited")
  assert.equal(delivered.json.messages[0].silent, true)
  assert.equal(delivered.json.messages[0].senderId, a.user.id)
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token })).json.scheduled.length, 0)

  // Send now, and delete.
  const two = await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token, body: { ciphertext: "now", sendAt: soon } })
  const sentNow = await api(s.base, `/api/conversations/${cid}/scheduled/${two.json.scheduled.id}/send-now`, { token: a.token, body: {} })
  assert.equal(sentNow.json.message.ciphertext, "now")
  const three = await api(s.base, `/api/conversations/${cid}/scheduled`, { token: a.token, body: { ciphertext: "never", sendAt: soon } })
  assert.equal((await api(s.base, `/api/conversations/${cid}/scheduled/${three.json.scheduled.id}/delete`, { token: a.token, body: {} })).status, 200)
  assert.equal(s.app.deliverDueScheduled(Date.now() + 3600000), 0)
})

test("a scheduled message is dropped when the sender lost the right to post", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "chanowner")
  const poster = await registerUser(s.base, "chanposter")
  await api(s.base, "/api/friends/requests", { token: owner.token, body: { username: "chanposter" } })
  await api(s.base, "/api/friends/requests", { token: poster.token, body: { username: "chanowner" } })
  const group = await api(s.base, "/api/conversations", { token: owner.token, body: { kind: "group", title: "G", memberUsernames: ["chanposter"] } })
  const cid = group.json.conversation.id as string
  await api(s.base, `/api/conversations/${cid}/scheduled`, { token: poster.token, body: { ciphertext: "x", sendAt: new Date(Date.now() + 60000).toISOString() } })
  await api(s.base, `/api/conversations/${cid}/members/${poster.user.id}/role`, { token: owner.token, body: { role: "restricted" } })
  assert.equal(s.app.deliverDueScheduled(Date.now() + 61000), 0)
  assert.equal((await api(s.base, `/api/conversations/${cid}/messages`, { token: owner.token })).json.messages.length, 0)
})

test("search corpus spans the user's chats only; windows open around a hit", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const one = await directConversation(s.base, "searcha", "searchb")
  const two = await directConversation(s.base, "searchc", "searchd")
  const ids: string[] = []
  for (let i = 0; i < 7; i++) {
    const r = await api(s.base, `/api/conversations/${one.cid}/messages`, { token: one.a.token, body: { ciphertext: "m" + i } })
    ids.push(r.json.message.id)
  }
  await api(s.base, `/api/conversations/${two.cid}/messages`, { token: two.a.token, body: { ciphertext: "foreign" } })
  const page = await api(s.base, "/api/search/messages?limit=4", { token: one.b.token })
  assert.deepEqual(page.json.messages.map((m: { ciphertext: string }) => m.ciphertext), ["m6", "m5", "m4", "m3"])
  const rest = await api(s.base, "/api/search/messages?limit=4&before=" + page.json.nextBefore, { token: one.b.token })
  assert.deepEqual(rest.json.messages.map((m: { ciphertext: string }) => m.ciphertext), ["m2", "m1", "m0"])
  assert.equal(rest.json.nextBefore, null)
  assert.equal((await api(s.base, "/api/search/messages?conversationId=" + two.cid, { token: one.b.token })).status, 403)

  const around = await api(s.base, `/api/conversations/${one.cid}/messages?around=${ids[3]}&limit=4`, { token: one.b.token })
  assert.deepEqual(around.json.messages.map((m: { ciphertext: string }) => m.ciphertext), ["m1", "m2", "m3", "m4"])
  assert.equal(around.json.hasMore, true)
  assert.equal(around.json.hasNewer, true)
  const newer = await api(s.base, `/api/conversations/${one.cid}/messages?after=${ids[4]}&limit=10`, { token: one.b.token })
  assert.deepEqual(newer.json.messages.map((m: { ciphertext: string }) => m.ciphertext), ["m5", "m6"])
  assert.equal((await api(s.base, `/api/conversations/${one.cid}/messages?around=${ids[3]}`, { token: two.a.token })).status, 403)
})

test("web push payloads decrypt with the subscription keys (RFC 8291)", () => {
  // A browser's side of the subscription.
  const browser = createECDH("prime256v1")
  browser.generateKeys()
  const authSecret = randomBytes(16)
  const subscription = { endpoint: "https://push.example.com/x", p256dh: browser.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") }
  const body = encryptPayload(subscription, Buffer.from(JSON.stringify({ title: "Hi" })))

  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const serverPublic = body.subarray(21, 21 + idlen)
  const sealed = body.subarray(21 + idlen)
  const shared = browser.computeSecret(serverPublic)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), serverPublic])
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16))
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12))
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  assert.equal(plain[plain.length - 1], 2)
  assert.deepEqual(JSON.parse(plain.subarray(0, plain.length - 1).toString()), { title: "Hi" })
})

test("VAPID tokens are ES256 JWTs for the push service origin", () => {
  const meta = new Map<string, string>()
  const keys = loadVapidKeys({ getMeta: (k) => meta.get(k) ?? null, setMeta: (k, v) => void meta.set(k, v) })
  // Stable across restarts.
  assert.equal(loadVapidKeys({ getMeta: (k) => meta.get(k) ?? null, setMeta: () => undefined }).publicKey, keys.publicKey)
  const header = vapidAuthorization("https://web.push.apple.com/abc", keys, "https://frontierx.example")
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
  assert.ok(match)
  const claims = JSON.parse(Buffer.from(match[2], "base64url").toString())
  assert.equal(claims.aud, "https://web.push.apple.com")
  assert.equal(claims.sub, "https://frontierx.example")
  assert.ok(claims.exp > Date.now() / 1000)
  const raw = Buffer.from(match[4], "base64url")
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" })
  const ok = verify("sha256", Buffer.from(match[1] + "." + match[2]), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(match[3], "base64url"))
  assert.equal(ok, true)
  void generateKeyPairSync
})

test("web push subscriptions are per account and endpoint-checked", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const u = await registerUser(s.base, "pusher")
  const vapid = await api(s.base, "/api/push/vapid")
  assert.equal(Buffer.from(vapid.json.publicKey, "base64url").length, 65)
  const browser = createECDH("prime256v1")
  browser.generateKeys()
  const body = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: browser.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }
  assert.equal((await api(s.base, "/api/me/push/webpush", { token: u.token, body: { ...body, endpoint: "https://127.0.0.1/x" } })).status, 400)
  assert.equal((await api(s.base, "/api/me/push/webpush", { token: u.token, body })).status, 200)
  const second = await registerUser(s.base, "pusher2")
  assert.equal((await api(s.base, "/api/me/push/webpush", { token: second.token, body })).status, 200)
  assert.equal(s.app.store.listWebPushSubscriptions(u.user.id).length, 1)
  assert.equal(s.app.store.listWebPushSubscriptions(second.user.id).length, 1)
  await api(s.base, "/api/me/push/webpush/delete", { token: u.token, body: { endpoint: body.endpoint } })
  assert.equal(s.app.store.listWebPushSubscriptions(u.user.id).length, 0)
  assert.equal(s.app.store.listWebPushSubscriptions(second.user.id).length, 1)
})
