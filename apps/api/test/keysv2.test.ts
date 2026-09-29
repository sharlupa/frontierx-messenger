import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as nodeSqlite from "node:sqlite"
import { Store } from "../src/store"
import { api, directConversation, registerUser, startTestServer } from "./helpers"

// Opaque stand-ins: the server never interprets key material, it only checks
// shape, ownership and who may write what.
const B = (label: string) => Buffer.from(label).toString("base64")
const slot = (kind: string, extra: Record<string, unknown> = {}) => ({
  kind,
  kdf: kind === "password" ? { alg: "PBKDF2-SHA256", iterations: 600000, salt: B("salt") } : { alg: "HKDF-SHA256", salt: B("salt") },
  iv: B("iv-" + kind),
  ciphertext: B("sealed-ak-" + kind),
  ...extra,
})
const bundle = (extraSlots: unknown[] = []) => ({
  password: "password123",
  check: { iv: B("check-iv"), ciphertext: B("check-ct") },
  slots: [slot("password"), ...extraSlots],
  vault: [{ scope: "identity", itemId: "a".repeat(32), iv: B("vi"), ciphertext: B("identity-pkcs8") }],
})

async function setKey(base: string, token: string, publicKey: string) {
  return api(base, "/api/me/publicKey", { token, body: { publicKey } })
}

test("account key is created once and survives as the identity of record", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  await setKey(s.base, alice.token, B("alice-pub-1"))

  const empty = await api(s.base, "/api/keys/state", { token: alice.token })
  assert.equal(empty.status, 200)
  assert.equal(empty.json.accountKey, null)

  const created = await api(s.base, "/api/keys/account", { token: alice.token, body: bundle() })
  assert.equal(created.status, 201)
  assert.equal(created.json.accountKey.check.ciphertext, B("check-ct"))
  assert.equal(created.json.slots.length, 1)
  assert.equal(created.json.slots[0].kind, "password")
  assert.equal(created.json.identities.length, 1)

  // A second device can never create a competing account key.
  const bob0 = await registerUser(s.base, "bobzero")
  assert.equal((await api(s.base, "/api/keys/account", { token: bob0.token, body: { ...bundle(), password: "not-the-password" } })).status, 401)
  const again = await api(s.base, "/api/keys/account", { token: alice.token, body: bundle() })
  assert.equal(again.status, 409)

  // With an account key, the identity only changes through the key system.
  const swap = await setKey(s.base, alice.token, B("alice-pub-2"))
  assert.equal(swap.status, 409)
  const same = await setKey(s.base, alice.token, B("alice-pub-1"))
  assert.equal(same.status, 200)

  // Nobody else reads the slots.
  const bob = await registerUser(s.base, "bob")
  const bobState = await api(s.base, "/api/keys/state", { token: bob.token })
  assert.equal(bobState.json.accountKey, null)
  assert.equal(bobState.json.slots.length, 0)
})

test("register can create the account key atomically", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const r = await api(s.base, "/api/auth/register", { body: { username: "carol", password: "password123", publicKey: B("carol-pub"), keys: bundle([slot("identity", { label: "b".repeat(32), kdf: { alg: "ECIES-P256", ephemeralPublicKey: B("eph") } })]) } })
  assert.equal(r.status, 201)
  const state = await api(s.base, "/api/keys/state", { token: r.json.token })
  assert.ok(state.json.accountKey)
  assert.deepEqual(state.json.slots.map((x: { kind: string }) => x.kind).sort(), ["identity", "password"])

  const broken = await api(s.base, "/api/auth/register", { body: { username: "dave", password: "password123", keys: { check: {}, slots: [] } } })
  assert.equal(broken.status, 400)
  // A refused bundle creates no account either.
  const login = await api(s.base, "/api/auth/login", { body: { username: "dave", password: "password123" } })
  assert.equal(login.status, 401)
})

test("slots: password and recovery replace their kind, the last way in stays", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const u = await registerUser(s.base, "slotter")
  await api(s.base, "/api/keys/account", { token: u.token, body: bundle() })
  // Password slots need the password; recovery slots do not.
  assert.equal((await api(s.base, "/api/keys/slots", { token: u.token, body: slot("password") })).status, 401)
  assert.equal((await api(s.base, "/api/keys/slots", { token: u.token, body: { ...slot("password"), password: "password123" } })).status, 201)
  const rec = await api(s.base, "/api/keys/slots", { token: u.token, body: slot("recovery") })
  assert.equal(rec.status, 201)
  const rec2 = await api(s.base, "/api/keys/slots", { token: u.token, body: slot("recovery", { ciphertext: B("second") }) })
  assert.equal(rec2.status, 201)
  const state = await api(s.base, "/api/keys/state", { token: u.token })
  const recovery = state.json.slots.filter((x: { kind: string }) => x.kind === "recovery")
  assert.equal(recovery.length, 1)
  assert.equal(recovery[0].ciphertext, B("second"))

  const password = state.json.slots.find((x: { kind: string }) => x.kind === "password")
  assert.equal((await api(s.base, `/api/keys/slots/${password.id}/delete`, { token: u.token, body: {} })).status, 200)
  // The recovery slot is now the only way in and cannot be removed.
  assert.equal((await api(s.base, `/api/keys/slots/${recovery[0].id}/delete`, { token: u.token, body: {} })).status, 409)

  const bad = await api(s.base, "/api/keys/slots", { token: u.token, body: { kind: "password", kdf: { alg: "PBKDF2-SHA256", iterations: 10 }, iv: B("x"), ciphertext: B("y") } })
  assert.equal(bad.status, 400)
})

test("password reset keeps the old password slot as stale; change re-seals it", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const u = await registerUser(s.base, "resetter")
  await api(s.base, "/api/keys/account", { token: u.token, body: bundle() })
  s.app.store.markPasswordSlotsStale(u.user.id, new Date().toISOString())
  const state = await api(s.base, "/api/keys/state", { token: u.token })
  assert.equal(state.json.slots[0].stale, true)

  // Changing the password needs the current one and a fresh slot.
  const wrong = await api(s.base, "/api/me/password", { token: u.token, body: { currentPassword: "nope-nope", newPassword: "password456", passwordSlot: slot("password") } })
  assert.equal(wrong.status, 401)
  const missing = await api(s.base, "/api/me/password", { token: u.token, body: { currentPassword: "password123", newPassword: "password456" } })
  assert.equal(missing.status, 400)
  const ok = await api(s.base, "/api/me/password", { token: u.token, body: { currentPassword: "password123", newPassword: "password456", passwordSlot: slot("password", { ciphertext: B("resealed") }) } })
  assert.equal(ok.status, 200)
  const after = await api(s.base, "/api/keys/state", { token: u.token })
  const pw = after.json.slots.filter((x: { kind: string }) => x.kind === "password")
  assert.equal(pw.length, 1)
  assert.equal(pw[0].stale, false)
  assert.equal(pw[0].ciphertext, B("resealed"))
  assert.equal((await api(s.base, "/api/auth/login", { body: { username: "resetter", password: "password456" } })).status, 200)
})

test("vault items are private and write-once", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a, b, cid } = await directConversation(s.base, "vaulta", "vaultb")
  await setKey(s.base, a.token, B("a-pub"))
  await setKey(s.base, b.token, B("b-pub"))
  await api(s.base, "/api/keys/account", { token: a.token, body: bundle() })
  // The epoch has to exist before its key can be stored.
  const early = await api(s.base, "/api/keys/vault", { token: a.token, body: { items: [{ scope: "cek", conversationId: cid, keyId: "k_abcdefgh12", iv: B("i"), ciphertext: B("c") }] } })
  assert.equal(early.status, 404)
  const epoch = await api(s.base, `/api/conversations/${cid}/keys/epochs`, {
    token: a.token,
    body: {
      keyId: "k_abcdefgh12",
      expectedCurrentKeyId: null,
      check: B("check"),
      shares: [
        { memberId: a.user.id, ephemeralPublicKey: B("e1"), iv: B("i1"), ciphertext: B("c1"), recipientKey: B("a-pub") },
        { memberId: b.user.id, ephemeralPublicKey: B("e2"), iv: B("i2"), ciphertext: B("c2"), recipientKey: B("b-pub") },
      ],
    },
  })
  assert.equal(epoch.status, 201)
  const first = await api(s.base, "/api/keys/vault", { token: a.token, body: { items: [{ scope: "cek", conversationId: cid, keyId: "k_abcdefgh12", iv: B("i"), ciphertext: B("first") }] } })
  assert.equal(first.json.added, 1)
  const second = await api(s.base, "/api/keys/vault", { token: a.token, body: { items: [{ scope: "cek", conversationId: cid, keyId: "k_abcdefgh12", iv: B("i"), ciphertext: B("second") }] } })
  assert.equal(second.json.added, 0)
  const mine = await api(s.base, "/api/keys/vault?conversationId=" + cid, { token: a.token })
  assert.equal(mine.json.items.length, 1)
  assert.equal(mine.json.items[0].ciphertext, B("first"))
  // Bob has no account key yet and no vault.
  assert.equal((await api(s.base, "/api/keys/vault?conversationId=" + cid, { token: b.token })).json.items.length, 0)
  const outsider = await registerUser(s.base, "vaultout")
  await api(s.base, "/api/keys/account", { token: outsider.token, body: bundle() })
  const foreign = await api(s.base, "/api/keys/vault", { token: outsider.token, body: { items: [{ scope: "cek", conversationId: cid, keyId: "k_abcdefgh12", iv: B("i"), ciphertext: B("x") }] } })
  assert.equal(foreign.status, 403)
})

test("key epochs switch by compare-and-set and never lose older keys", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a, b, cid } = await directConversation(s.base, "epocha", "epochb")
  await setKey(s.base, a.token, B("a-pub"))
  await setKey(s.base, b.token, B("b-pub"))
  const share = (memberId: string, pub: string, tag: string) => ({ memberId, ephemeralPublicKey: B("e" + tag), iv: B("i" + tag), ciphertext: B("c" + tag), recipientKey: B(pub) })

  const k1 = await api(s.base, `/api/conversations/${cid}/keys/epochs`, { token: a.token, body: { keyId: "k_first00001", expectedCurrentKeyId: null, check: B("c1"), shares: [share(a.user.id, "a-pub", "1"), share(b.user.id, "b-pub", "2")] } })
  assert.equal(k1.status, 201)
  // Bob raced with the same expectation and lost: he learns the winner.
  const race = await api(s.base, `/api/conversations/${cid}/keys/epochs`, { token: b.token, body: { keyId: "k_second0001", expectedCurrentKeyId: null, check: B("c2"), shares: [share(b.user.id, "b-pub", "3")] } })
  assert.equal(race.status, 409)
  assert.equal(race.json.currentKeyId, "k_first00001")
  // Copies must be wrapped for the member's current key and include the creator.
  const stale = await api(s.base, `/api/conversations/${cid}/keys/epochs`, { token: b.token, body: { keyId: "k_third00001", expectedCurrentKeyId: "k_first00001", check: B("c3"), shares: [share(b.user.id, "b-pub", "4"), share(a.user.id, "old-a", "5")] } })
  assert.equal(stale.status, 409)
  const noSelf = await api(s.base, `/api/conversations/${cid}/keys/epochs`, { token: b.token, body: { keyId: "k_third00001", expectedCurrentKeyId: "k_first00001", check: B("c3"), shares: [share(a.user.id, "a-pub", "6")] } })
  assert.equal(noSelf.status, 400)
  const k2 = await api(s.base, `/api/conversations/${cid}/keys/epochs`, { token: b.token, body: { keyId: "k_third00001", expectedCurrentKeyId: "k_first00001", check: B("c3"), shares: [share(b.user.id, "b-pub", "7"), share(a.user.id, "a-pub", "8")] } })
  assert.equal(k2.status, 201)

  const view = await api(s.base, `/api/conversations/${cid}/keys`, { token: a.token })
  assert.equal(view.json.currentKeyId, "k_third00001")
  assert.deepEqual(view.json.epochs.map((e: { keyId: string }) => e.keyId), ["k_first00001", "k_third00001"])
  assert.deepEqual(view.json.shares.map((x: { keyId: string }) => x.keyId).sort(), ["k_first00001", "k_third00001"])
})

test("members hand over keys others lack, and a bad copy can be rejected", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const a = await registerUser(s.base, "sharea")
  const b = await registerUser(s.base, "shareb")
  const c = await registerUser(s.base, "sharec")
  for (const [u, pub] of [[a, "a-pub"], [b, "b-pub"], [c, "c-pub"]] as const) await setKey(s.base, u.token, B(pub))
  // Group of friends.
  await api(s.base, "/api/friends/requests", { token: a.token, body: { username: "shareb" } })
  await api(s.base, "/api/friends/requests", { token: b.token, body: { username: "sharea" } })
  await api(s.base, "/api/friends/requests", { token: a.token, body: { username: "sharec" } })
  await api(s.base, "/api/friends/requests", { token: c.token, body: { username: "sharea" } })
  const group = await api(s.base, "/api/conversations", { token: a.token, body: { kind: "group", title: "G", memberUsernames: ["shareb"] } })
  const cid = group.json.conversation.id as string
  const share = (memberId: string, pub: string, tag: string, keyId?: string) => ({ keyId, memberId, ephemeralPublicKey: B("e" + tag), iv: B("i" + tag), ciphertext: B("c" + tag), recipientKey: B(pub) })
  assert.equal((await api(s.base, `/api/conversations/${cid}/keys/epochs`, { token: a.token, body: { keyId: "k_groupkey01", expectedCurrentKeyId: null, check: B("x"), shares: [share(a.user.id, "a-pub", "1"), share(b.user.id, "b-pub", "2")] } })).status, 201)

  // Carol joins: every holder of the key sees her in the pending list.
  assert.equal((await api(s.base, `/api/conversations/${cid}/members/add`, { token: a.token, body: { usernames: ["sharec"] } })).status, 200)
  const pendingA = await api(s.base, "/api/keys/pending", { token: a.token })
  assert.deepEqual(pendingA.json.missing.map((m: { memberId: string; keyId: string }) => m.memberId + "|" + m.keyId), [c.user.id + "|k_groupkey01"])
  assert.equal(pendingA.json.missing[0].publicKey, B("c-pub"))
  // Carol holds nothing yet, so nothing is pending for her to hand over.
  assert.equal((await api(s.base, "/api/keys/pending", { token: c.token })).json.missing.length, 0)
  // She cannot hand over a key she does not hold.
  const forged = await api(s.base, `/api/conversations/${cid}/keys/shares`, { token: c.token, body: { shares: [share(b.user.id, "b-pub", "9", "k_groupkey01")] } })
  assert.equal(forged.status, 403)

  const handed = await api(s.base, `/api/conversations/${cid}/keys/shares`, { token: b.token, body: { shares: [share(c.user.id, "c-pub", "3", "k_groupkey01")] } })
  assert.equal(handed.json.added, 1)
  // Copies are never replaced by someone else.
  const replace = await api(s.base, `/api/conversations/${cid}/keys/shares`, { token: a.token, body: { shares: [share(c.user.id, "c-pub", "4", "k_groupkey01")] } })
  assert.equal(replace.json.added, 0)
  assert.equal((await api(s.base, "/api/keys/pending", { token: a.token })).json.missing.length, 0)

  // Carol's copy does not open: she drops it and it becomes pending again.
  assert.equal((await api(s.base, `/api/conversations/${cid}/keys/reject`, { token: c.token, body: { keyId: "k_groupkey01" } })).json.removed, true)
  assert.equal((await api(s.base, "/api/keys/pending", { token: b.token })).json.missing.length, 1)

  // A copy nobody else holds is never dropped.
  const solo = await api(s.base, "/api/conversations", { token: a.token, body: { kind: "group", title: "Solo" } })
  const soloId = solo.json.conversation.id as string
  await api(s.base, `/api/conversations/${soloId}/keys/epochs`, { token: a.token, body: { keyId: "k_solokey001", expectedCurrentKeyId: null, check: B("x"), shares: [share(a.user.id, "a-pub", "s")] } })
  const kept = await api(s.base, `/api/conversations/${soloId}/keys/reject`, { token: a.token, body: { keyId: "k_solokey001" } })
  assert.equal(kept.status, 409)
  assert.equal((await api(s.base, `/api/conversations/${soloId}/keys`, { token: a.token })).json.shares.length, 1)

  // Leaving re-keys the group on the next message.
  await api(s.base, `/api/conversations/${cid}/leave`, { token: c.token, body: {} })
  const view = await api(s.base, `/api/conversations/${cid}/keys`, { token: a.token })
  assert.equal(view.json.rekeyNeeded, true)
  assert.equal(view.json.missing.length, 0)
  // Outsiders see nothing.
  assert.equal((await api(s.base, `/api/conversations/${cid}/keys`, { token: c.token })).status, 403)
})

test("first-generation keys are imported as the legacy epoch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fx-legacy-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "legacy.db")
  const DatabaseSync = (nodeSqlite as unknown as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } }).DatabaseSync
  const seed = new Store(path)
  seed.close()
  // Simulate a database from before key system v2.
  const raw = new DatabaseSync(path)
  raw.exec("DELETE FROM app_meta")
  raw.exec("DELETE FROM conversation_key_epochs")
  raw.exec("DELETE FROM conversation_key_shares")
  raw.exec("INSERT INTO conversations(id,kind,title,created_by,created_at) VALUES('conv_old','group','Old','u1','2026-01-01T00:00:00.000Z')")
  raw.exec("INSERT INTO members(conversation_id,user_id,role,joined_at) VALUES('conv_old','u1','owner','2026-01-01T00:00:00.000Z'),('conv_old','u2','member','2026-01-01T00:00:00.000Z')")
  raw.exec("INSERT INTO conversation_keys(conversation_id,member_id,ephemeral_public_key,iv,ciphertext,created_by,created_at) VALUES('conv_old','u1','E1','I1','C1','u1','2026-01-02T00:00:00.000Z'),('conv_old','u2','E2','I2','C2','u1','2026-01-02T00:00:00.000Z')")
  raw.close()
  const store = new Store(path)
  t.after(() => store.close())
  assert.deepEqual(store.listKeyEpochs("conv_old").map((e) => e.keyId), ["legacy"])
  assert.equal(store.getConversationKeyState("conv_old").currentKeyId, "legacy")
  assert.equal(store.getKeyShare("conv_old", "legacy", "u2")?.ciphertext, "C2")
  // Running the import again changes nothing.
  store.setMeta("keys_v2_legacy_import", "")
  const again = new Store(path)
  assert.equal(again.listKeyShareMemberIds("conv_old", "legacy").length, 2)
  again.close()
})

test("old clients keep using the legacy routes; their destructive reset is refused", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a, b, cid } = await directConversation(s.base, "olda", "oldb")
  const posted = await api(s.base, `/api/conversations/${cid}/keys`, { token: a.token, body: { entries: [{ memberId: a.user.id, ephemeralPublicKey: "EA", iv: "IA", ciphertext: "CA" }, { memberId: b.user.id, ephemeralPublicKey: "EB", iv: "IB", ciphertext: "CB" }] } })
  assert.equal(posted.json.count, 2)
  const mine = await api(s.base, `/api/conversations/${cid}/keys/mine`, { token: b.token })
  assert.equal(mine.json.entry.ciphertext, "CB")
  const view = await api(s.base, `/api/conversations/${cid}/keys`, { token: b.token })
  assert.equal(view.json.currentKeyId, "legacy")
  const rotate = await api(s.base, `/api/conversations/${cid}/keys`, { token: a.token, body: { rotate: true, entries: [] } })
  assert.equal(rotate.status, 409)
})

test("device linking relays a sealed key between two sessions of one account", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await registerUser(s.base, "linker")
  const oldDevice = await api(s.base, "/api/auth/login", { body: { username: "linker", password: "password123", deviceId: "old-device" } })
  const newDevice = await api(s.base, "/api/auth/login", { body: { username: "linker", password: "password123", deviceId: "new-device" } })
  const requested = await api(s.base, "/api/keys/link", { token: newDevice.json.token, body: { ephemeralPublicKey: B("eph-new"), label: "Phone" } })
  assert.equal(requested.status, 201)
  const id = requested.json.id as string
  // The requesting device neither sees nor approves its own request.
  assert.equal((await api(s.base, "/api/keys/link/pending", { token: newDevice.json.token })).json.requests.length, 0)
  assert.equal((await api(s.base, `/api/keys/link/${id}/approve`, { token: newDevice.json.token, body: { ephemeralPublicKey: B("x"), iv: B("y"), ciphertext: B("z") } })).status, 403)
  const pending = await api(s.base, "/api/keys/link/pending", { token: oldDevice.json.token })
  assert.equal(pending.json.requests[0].ephemeralPublicKey, B("eph-new"))
  // Another account cannot touch it.
  const stranger = await registerUser(s.base, "stranger")
  assert.equal((await api(s.base, `/api/keys/link/${id}/approve`, { token: stranger.token, body: { ephemeralPublicKey: B("x"), iv: B("y"), ciphertext: B("z") } })).status, 404)
  assert.equal((await api(s.base, `/api/keys/link/${id}`, { token: oldDevice.json.token })).status, 404)

  assert.equal((await api(s.base, `/api/keys/link/${id}`, { token: newDevice.json.token })).json.status, "pending")
  assert.equal((await api(s.base, `/api/keys/link/${id}/approve`, { token: oldDevice.json.token, body: { ephemeralPublicKey: B("eph-old"), iv: B("iv"), ciphertext: B("sealed-ak") } })).status, 200)
  const result = await api(s.base, `/api/keys/link/${id}`, { token: newDevice.json.token })
  assert.equal(result.json.status, "approved")
  assert.equal(result.json.response.ciphertext, B("sealed-ak"))
  // Handed over exactly once.
  assert.equal((await api(s.base, `/api/keys/link/${id}`, { token: newDevice.json.token })).status, 404)
})

test("starting over needs the password and drops the old copies", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a, b, cid } = await directConversation(s.base, "overa", "overb")
  await setKey(s.base, a.token, B("a-pub"))
  await setKey(s.base, b.token, B("b-pub"))
  await api(s.base, "/api/keys/account", { token: a.token, body: bundle() })
  await api(s.base, `/api/conversations/${cid}/keys/epochs`, {
    token: b.token,
    body: { keyId: "k_resetkey01", expectedCurrentKeyId: null, check: B("x"), shares: [{ memberId: b.user.id, ephemeralPublicKey: B("e"), iv: B("i"), ciphertext: B("c"), recipientKey: B("b-pub") }, { memberId: a.user.id, ephemeralPublicKey: B("e"), iv: B("i"), ciphertext: B("c"), recipientKey: B("a-pub") }] },
  })
  const denied = await api(s.base, "/api/keys/reset", { token: a.token, body: { ...bundle(), password: "wrong-password", publicKey: B("a-new") } })
  assert.equal(denied.status, 401)
  const reset = await api(s.base, "/api/keys/reset", { token: a.token, body: { ...bundle(), password: "password123", publicKey: B("a-new") } })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.publicKey, B("a-new"))
  // Bob's device now sees Alice as missing the key and can hand it over.
  const pending = await api(s.base, "/api/keys/pending", { token: b.token })
  assert.equal(pending.json.missing.length, 1)
  assert.equal(pending.json.missing[0].publicKey, B("a-new"))
})

test("a lost identity is replaced only with the password", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const u = await registerUser(s.base, "repairer")
  await setKey(s.base, u.token, B("old-pub"))
  await api(s.base, "/api/keys/account", { token: u.token, body: bundle() })
  const body = {
    publicKey: B("new-pub"),
    identity: { scope: "identity", itemId: "c".repeat(32), iv: B("i"), ciphertext: B("c") },
    slot: slot("identity", { label: "c".repeat(32), kdf: { alg: "ECIES-P256", ephemeralPublicKey: B("e") } }),
  }
  assert.equal((await api(s.base, "/api/keys/identity", { token: u.token, body: { ...body, password: "wrong-one" } })).status, 401)
  const ok = await api(s.base, "/api/keys/identity", { token: u.token, body: { ...body, password: "password123" } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.publicKey, B("new-pub"))
  assert.equal(ok.json.identities.length, 2)
})
