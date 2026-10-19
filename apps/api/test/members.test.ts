import { test } from "node:test"
import assert from "node:assert/strict"
import { api, befriend, registerUser, startTestServer, directConversation } from "./helpers"

// A group with an owner, an admin and two ordinary members, all friends of
// the owner so they can be added.
async function groupOfFour(base: string, prefix: string, kind: "group" | "channel" = "group") {
  const owner = await registerUser(base, prefix + "_own")
  const admin = await registerUser(base, prefix + "_adm")
  const m1 = await registerUser(base, prefix + "_m1")
  const m2 = await registerUser(base, prefix + "_m2")
  for (const other of [admin, m1, m2]) await befriend(base, owner, other)
  const created = await api(base, "/api/conversations", { token: owner.token, body: { kind, title: "Team", memberUsernames: [admin.user.username, m1.user.username, m2.user.username] } })
  const cid = created.json.conversation.id as string
  assert.equal((await api(base, `/api/conversations/${cid}/members/${admin.user.id}/role`, { token: owner.token, body: { role: "admin" } })).status, 200)
  return { owner, admin, m1, m2, cid }
}

const memberIds = async (base: string, token: string, cid: string): Promise<string[]> =>
  (await api(base, `/api/conversations/${cid}/members`, { token })).json.members.map((m: { userId: string }) => m.userId)

test("a moderator removes a member, who loses the chat and its call", async (t) => {
  const s = await startTestServer({ callReconnectGraceMs: 0 })
  t.after(() => s.close())
  const { owner, admin, m1, m2, cid } = await groupOfFour(s.base, "kick")
  const seen: Record<string, unknown[]> = { m1: [], m2: [] }
  s.app.bus.subscribeUser(m1.user.id, (event) => seen.m1.push(event))
  s.app.bus.subscribeUser(m2.user.id, (event) => seen.m2.push(event))
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m1.token, body: {} })
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m2.token, body: {} })

  const removed = await api(s.base, `/api/conversations/${cid}/members/${m1.user.id}/remove`, { token: admin.token, body: {} })
  assert.equal(removed.status, 200)
  assert.deepEqual((await memberIds(s.base, owner.token, cid)).sort(), [owner.user.id, admin.user.id, m2.user.id].sort())
  assert.equal((await api(s.base, `/api/conversations/${cid}/messages`, { token: m1.token })).status, 403, "no access to the chat any more")
  assert.deepEqual((await api(s.base, `/api/conversations/${cid}/call`, { token: m2.token })).json.call.participants, [m2.user.id], "taken out of the call")

  const gone = seen.m1.find((event: any) => event.type === "conversation.deleted") as any
  assert.equal(gone?.conversationId, cid)
  assert.equal(gone?.removedBy, admin.user.id)
  assert.equal(gone?.title, "Team")
  assert.ok(seen.m2.some((event: any) => event.type === "member.removed" && event.userId === m1.user.id && event.removedBy === admin.user.id))
  assert.ok(seen.m2.some((event: any) => event.type === "call.left" && event.userId === m1.user.id))
})

test("who may remove whom", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { owner, admin, m1, m2, cid } = await groupOfFour(s.base, "perm")
  const remove = (token: string, target: string) => api(s.base, `/api/conversations/${cid}/members/${target}/remove`, { token, body: {} })
  assert.equal((await remove(m1.token, m2.user.id)).status, 403, "ordinary members cannot remove")
  assert.equal((await remove(admin.token, owner.user.id)).status, 403, "nobody removes the owner")
  assert.equal((await remove(owner.token, owner.user.id)).status, 409, "the owner leaves, not removes themselves")
  assert.equal((await remove(admin.token, admin.user.id)).status, 409)
  assert.equal((await remove(owner.token, "user_missing")).status, 404)
  // A second admin: admins cannot remove each other, the owner can.
  assert.equal((await api(s.base, `/api/conversations/${cid}/members/${m2.user.id}/role`, { token: owner.token, body: { role: "admin" } })).status, 200)
  assert.equal((await remove(admin.token, m2.user.id)).status, 403)
  assert.equal((await remove(owner.token, m2.user.id)).status, 200)
  assert.equal((await remove(owner.token, admin.user.id)).status, 200)
  assert.deepEqual((await memberIds(s.base, owner.token, cid)).sort(), [owner.user.id, m1.user.id].sort())
})

test("members of channels can be removed; direct chats have no members to remove", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { owner, m1, cid } = await groupOfFour(s.base, "chan", "channel")
  assert.equal((await api(s.base, `/api/conversations/${cid}/members/${m1.user.id}/remove`, { token: owner.token, body: {} })).status, 200)
  const { a, b, cid: direct } = await directConversation(s.base, "kd_a", "kd_b")
  assert.equal((await api(s.base, `/api/conversations/${direct}/members/${b.user.id}/remove`, { token: a.token, body: {} })).status, 409)
})

test("leaving a group also leaves its call", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { m1, m2, cid } = await groupOfFour(s.base, "quit")
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m1.token, body: {} })
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m2.token, body: {} })
  assert.equal((await api(s.base, `/api/conversations/${cid}/leave`, { token: m1.token, body: {} })).status, 200)
  assert.deepEqual((await api(s.base, `/api/conversations/${cid}/call`, { token: m2.token })).json.call.participants, [m2.user.id])
})

test("only people in the call exchange call signals", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { owner, m1, m2, cid } = await groupOfFour(s.base, "sig")
  const signal = (token: string, to: string) => api(s.base, `/api/conversations/${cid}/call/signal`, { token, body: { to, callId: "x", data: { kind: "candidate", candidate: {} } } })
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m1.token, body: {} })
  assert.equal((await signal(owner.token, m1.user.id)).status, 409, "a member outside the call cannot reach a participant")
  assert.equal((await signal(m1.token, m2.user.id)).status, 409, "nor can a participant reach someone outside it")
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m2.token, body: {} })
  assert.equal((await signal(m1.token, m2.user.id)).status, 202)
})

test("joining again while still on the roster restarts that person's connections", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { m1, m2, cid } = await groupOfFour(s.base, "rejoin")
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m1.token, body: {} })
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m2.token, body: {} })
  const seen: Array<{ type: string; userId?: string }> = []
  s.app.bus.subscribeUser(m1.user.id, (event) => seen.push(event as { type: string; userId?: string }))
  await api(s.base, `/api/conversations/${cid}/call/join`, { token: m2.token, body: {} })
  const order = seen.filter((event) => event.userId === m2.user.id).map((event) => event.type)
  assert.deepEqual(order, ["call.left", "call.joined"])
})
