import { test } from "node:test"
import assert from "node:assert/strict"
import { api, befriend, registerUser, startTestServer } from "./helpers"

async function group(base: string) {
  const owner = await registerUser(base, "owner")
  const member = await registerUser(base, "member")
  await befriend(base, owner, member)
  const created = await api(base, "/api/conversations", { token: owner.token, body: { kind: "group", title: "Team", memberUsernames: ["member"] } })
  return { owner, member, id: created.json.conversation.id as string }
}

test("archive state is private to a member and is reversible", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await group(s.base)
  const archived = await api(s.base, `/api/conversations/${c.id}/archive`, { token: c.member.token, body: { archived: true } })
  assert.equal(archived.status, 200)
  assert.ok(archived.json.archivedAt)
  const mine = await api(s.base, "/api/conversations", { token: c.member.token })
  const owners = await api(s.base, "/api/conversations", { token: c.owner.token })
  const mineConv = mine.json.conversations.find((x: any) => x.id === c.id)
  const ownerConv = owners.json.conversations.find((x: any) => x.id === c.id)
  assert.ok(mineConv.archivedAt)
  assert.equal(ownerConv.archivedAt, null)
  const restored = await api(s.base, `/api/conversations/${c.id}/archive`, { token: c.member.token, body: { archived: false } })
  assert.equal(restored.json.archivedAt, null)
})

test("only moderators can pin messages and deleted pins disappear", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await group(s.base)
  const sent = await api(s.base, `/api/conversations/${c.id}/messages`, { token: c.member.token, body: { ciphertext: "opaque-message" } })
  const messageId = sent.json.message.id as string
  const denied = await api(s.base, `/api/conversations/${c.id}/messages/${messageId}/pin`, { token: c.member.token, body: { active: true } })
  assert.equal(denied.status, 403)
  const pinned = await api(s.base, `/api/conversations/${c.id}/messages/${messageId}/pin`, { token: c.owner.token, body: { active: true } })
  assert.equal(pinned.status, 200)
  const list = await api(s.base, `/api/conversations/${c.id}/pinned`, { token: c.member.token })
  assert.equal(list.json.pinned.length, 1)
  await api(s.base, `/api/conversations/${c.id}/messages/${messageId}/delete`, { token: c.member.token, body: {} })
  const afterDelete = await api(s.base, `/api/conversations/${c.id}/pinned`, { token: c.owner.token })
  assert.equal(afterDelete.json.pinned.length, 0)
})

test("owners can assign a restricted role and restricted members cannot send", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await group(s.base)
  const changed = await api(s.base, `/api/conversations/${c.id}/members/${c.member.user.id}/role`, { token: c.owner.token, body: { role: "restricted" } })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.member.role, "restricted")
  const denied = await api(s.base, `/api/conversations/${c.id}/messages`, { token: c.member.token, body: { ciphertext: "must-not-send" } })
  assert.equal(denied.status, 403)
  const notOwner = await api(s.base, `/api/conversations/${c.id}/members/${c.member.user.id}/role`, { token: c.member.token, body: { role: "admin" } })
  assert.equal(notOwner.status, 403)
  const promoted = await api(s.base, `/api/conversations/${c.id}/members/${c.member.user.id}/role`, { token: c.owner.token, body: { role: "admin" } })
  assert.equal(promoted.status, 200)
  const allowed = await api(s.base, `/api/conversations/${c.id}/messages`, { token: c.member.token, body: { ciphertext: "allowed-now" } })
  assert.equal(allowed.status, 201)
})

test("channels accept posts only from their owner or administrators", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "publisher")
  const reader = await registerUser(s.base, "reader")
  await befriend(s.base, owner, reader)
  const created = await api(s.base, "/api/conversations", { token: owner.token, body: { kind: "channel", title: "News", memberUsernames: ["reader"] } })
  const id = created.json.conversation.id as string
  const denied = await api(s.base, `/api/conversations/${id}/messages`, { token: reader.token, body: { ciphertext: "reader-post" } })
  assert.equal(denied.status, 403)
  const allowed = await api(s.base, `/api/conversations/${id}/messages`, { token: owner.token, body: { ciphertext: "owner-post" } })
  assert.equal(allowed.status, 201)
})