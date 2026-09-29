import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, registerUser, directConversation } from "./helpers"

test("a member can post and read messages in a conversation", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a: alice, b: bob, cid } = await directConversation(s.base, "alice", "bob")
  const members = await api(s.base, `/api/conversations/${cid}/members`, { token: alice.token })
  assert.equal(members.json.members.length, 2)

  const post = await api(s.base, `/api/conversations/${cid}/messages`, {
    token: alice.token,
    body: { ciphertext: "AAAA-encrypted-blob" },
  })
  assert.equal(post.status, 201)
  assert.equal(post.json.message.ciphertext, "AAAA-encrypted-blob")
  assert.equal(post.json.message.senderId, alice.user.id)

  const list = await api(s.base, `/api/conversations/${cid}/messages`, { token: bob.token })
  assert.equal(list.status, 200)
  assert.equal(list.json.messages.length, 1)
  assert.equal(list.json.messages[0].ciphertext, "AAAA-encrypted-blob")
})

test("posting without ciphertext is rejected", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  const conv = await api(s.base, "/api/conversations", { token: alice.token, body: { kind: "group", title: "X" } })
  const cid = conv.json.conversation.id
  const post = await api(s.base, `/api/conversations/${cid}/messages`, { token: alice.token, body: {} })
  assert.equal(post.status, 400)
})

test("non-members cannot read or post", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  const mallory = await registerUser(s.base, "mallory")
  const conv = await api(s.base, "/api/conversations", {
    token: alice.token,
    body: { kind: "group", title: "Private" },
  })
  const cid = conv.json.conversation.id
  assert.equal((await api(s.base, `/api/conversations/${cid}/messages`, { token: mallory.token })).status, 403)
  assert.equal(
    (
      await api(s.base, `/api/conversations/${cid}/messages`, {
        token: mallory.token,
        body: { ciphertext: "x" },
      })
    ).status,
    403,
  )
})

test("message.created is delivered to conversation members over the bus", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a: alice, b: bob, cid } = await directConversation(s.base, "alice", "bob")

  const received: any[] = []
  const unsubscribe = s.app.bus.subscribeUser(bob.user.id, (e) => received.push(e))
  t.after(() => unsubscribe())

  await api(s.base, `/api/conversations/${cid}/messages`, { token: alice.token, body: { ciphertext: "hello" } })
  const created = received.filter((event) => event.type === "message.created")
  assert.equal(created.length, 1)
  assert.equal(created[0].message.ciphertext, "hello")
})