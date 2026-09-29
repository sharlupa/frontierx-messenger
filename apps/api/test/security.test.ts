import { test } from "node:test"
import assert from "node:assert/strict"
import { assertPublicUrl, isPublicAddress } from "../src/netguard"
import { isAcceptableEndpoint } from "../src/push"
import { api, directConversation, registerUser, startTestServer } from "./helpers"

test("outbound guard refuses loopback, private, mapped and local addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fd00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::"]) {
    assert.equal(isPublicAddress(address), false, address)
  }
  assert.equal(isPublicAddress("1.1.1.1"), true)
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true)
  for (const raw of ["http://127.0.0.1:2019/stop", "http://[::1]/", "http://localhost/", "http://x.internal/", "file:///etc/passwd", "http://user:pw@example.com/"]) {
    assert.throws(() => assertPublicUrl(raw), raw)
  }
  assert.equal(assertPublicUrl("https://example.com/a").hostname, "example.com")
})

test("push endpoints must be public https addresses", () => {
  assert.equal(isAcceptableEndpoint("http://127.0.0.1:2019/stop"), false)
  assert.equal(isAcceptableEndpoint("https://127.0.0.1/"), false)
  assert.equal(isAcceptableEndpoint("http://ntfy.sh/topic"), false)
  assert.equal(isAcceptableEndpoint("https://ntfy.sh/upAbc123"), true)
})

test("push register rejects an internal endpoint", async () => {
  const s = await startTestServer()
  try {
    const u = await registerUser(s.base, "pushsec")
    const r = await api(s.base, "/api/me/push/register", { token: u.token, body: { endpoint: "http://127.0.0.1:2019/stop" } })
    assert.equal(r.status, 400)
  } finally {
    await s.close()
  }
})

test("user search treats % and _ literally", async () => {
  const s = await startTestServer()
  try {
    const a = await registerUser(s.base, "searcher")
    await registerUser(s.base, "someone_else")
    const all = await api(s.base, "/api/users/search?q=" + encodeURIComponent("%%"), { token: a.token })
    assert.equal(all.status, 200)
    assert.equal(all.json.users.length, 0)
    const literal = await api(s.base, "/api/users/search?q=" + encodeURIComponent("e_e"), { token: a.token })
    assert.deepEqual(literal.json.users.map((u: { username: string }) => u.username), ["someone_else"])
  } finally {
    await s.close()
  }
})

test("account deletion by password shares the per-account lockout", async () => {
  const s = await startTestServer()
  try {
    await registerUser(s.base, "victim")
    let last = 0
    for (let i = 0; i < 9; i++) {
      last = (await api(s.base, "/api/account/delete", { body: { username: "victim", password: "wrong-" + i } })).status
    }
    assert.equal(last, 429)
  } finally {
    await s.close()
  }
})

test("receipts and replies must reference a message of the same conversation", async () => {
  const s = await startTestServer()
  try {
    const one = await directConversation(s.base, "rcpa", "rcpb")
    const two = await directConversation(s.base, "rcpc", "rcpd")
    const foreign = await api(s.base, `/api/conversations/${two.cid}/messages`, { token: two.a.token, body: { ciphertext: "x" } })
    const receipt = await api(s.base, `/api/conversations/${one.cid}/receipts`, { token: one.a.token, body: { messageId: foreign.json.message.id } })
    assert.equal(receipt.status, 404)
    const reply = await api(s.base, `/api/conversations/${one.cid}/messages`, { token: one.a.token, body: { ciphertext: "y", replyTo: foreign.json.message.id } })
    assert.equal(reply.status, 404)
  } finally {
    await s.close()
  }
})

async function groupWithMember(base: string, prefix: string) {
  const { a, b } = await directConversation(base, prefix + "own", prefix + "mem")
  const group = await api(base, "/api/conversations", { token: a.token, body: { kind: "group", title: "G", memberUsernames: [b.user.username] } })
  return { owner: a, member: b, gid: group.json.conversation.id as string }
}

// Replacing everyone's key used to wipe the readable history of a chat. Key
// system v2 adds new keys instead, so the old destructive reset is refused for
// everybody, owners included; adding a missing copy still works.
test("nobody can wipe a group's keys through the old reset route", async () => {
  const s = await startTestServer()
  try {
    const { owner, member, gid } = await groupWithMember(s.base, "rk")
    const entry = { memberId: member.user.id, ephemeralPublicKey: "e", iv: "i", ciphertext: "c" }
    const denied = await api(s.base, `/api/conversations/${gid}/keys`, { token: member.token, body: { entries: [entry], rotate: true } })
    assert.equal(denied.status, 409)
    const additive = await api(s.base, `/api/conversations/${gid}/keys`, { token: member.token, body: { entries: [entry] } })
    assert.equal(additive.status, 201)
    const ownerReset = await api(s.base, `/api/conversations/${gid}/keys`, { token: owner.token, body: { entries: [entry], rotate: true } })
    assert.equal(ownerReset.status, 409)
    const kept = await api(s.base, `/api/conversations/${gid}/keys/mine`, { token: member.token })
    assert.equal(kept.json.entry.ciphertext, "c")
  } finally {
    await s.close()
  }
})

test("invite links honour the lifetime chosen by their creator", async () => {
  const s = await startTestServer()
  try {
    const { owner, gid } = await groupWithMember(s.base, "iv")
    const forever = await api(s.base, `/api/conversations/${gid}/invite`, { token: owner.token, body: {} })
    assert.equal(forever.json.expiresAt, null)
    assert.equal((await api(s.base, `/api/invites/${forever.json.code}`)).status, 200)
    const bad = await api(s.base, `/api/conversations/${gid}/invite`, { token: owner.token, body: { expiresInSeconds: 5 } })
    assert.equal(bad.status, 400)
    const hour = await api(s.base, `/api/conversations/${gid}/invite`, { token: owner.token, body: { expiresInSeconds: 3600 } })
    assert.ok(Date.parse(hour.json.expiresAt) > Date.now())
    // Expire it by hand instead of waiting an hour.
    s.app.store.createInvite({ code: hour.json.code, conversationId: gid, createdBy: owner.user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() })
    const stranger = await registerUser(s.base, "ivstranger")
    assert.equal((await api(s.base, `/api/invites/${hour.json.code}`)).status, 410)
    assert.equal((await api(s.base, `/api/invites/${hour.json.code}/join`, { token: stranger.token, body: {} })).status, 404)
  } finally {
    await s.close()
  }
})

test("uploads stop at the per-user storage quota", async () => {
  const s = await startTestServer({ limits: { userStorageQuotaBytes: 1000, diskReserveBytes: 0 } })
  try {
    const { a, cid } = await directConversation(s.base, "qta", "qtb")
    const tooBig = await api(s.base, "/api/files", { token: a.token, body: { conversationId: cid, size: 2000, name: "f" } })
    assert.equal(tooBig.status, 413)
    const file = await api(s.base, "/api/files", { token: a.token, body: { conversationId: cid, size: 600, name: "f" } })
    const first = await fetch(`${s.base}/api/files/${file.json.asset.id}/blob`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: new Uint8Array(600) })
    assert.equal(first.status, 200)
    const second = await api(s.base, "/api/files", { token: a.token, body: { conversationId: cid, size: 600, name: "g" } })
    assert.equal(second.status, 413)
    // Re-uploading the same file replaces its bytes and stays within quota.
    const again = await fetch(`${s.base}/api/files/${file.json.asset.id}/blob`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: new Uint8Array(900) })
    assert.equal(again.status, 200)
  } finally {
    await s.close()
  }
})
