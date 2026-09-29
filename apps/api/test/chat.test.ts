import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, directConversation } from "./helpers"

// Chat surface: editing, deleting, reactions, typing, and paginated history.
// Every case boots an isolated in-memory app and talks to it over real HTTP.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function direct(base: string) {
  const { a, b, cid } = await directConversation(base, "alice", "bob")
  return { alice: a, bob: b, cid }
}

async function post(base: string, token: string, cid: string, text: string) {
  const r = await api(base, "/api/conversations/" + cid + "/messages", { token, body: { ciphertext: text } })
  return r.json.message.id as string
}

test("the author can edit a message and members are notified", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await direct(s.base)
  const mid = await post(s.base, c.alice.token, c.cid, "first-blob")
  const received: any[] = []
  const unsubscribe = s.app.bus.subscribeUser(c.bob.user.id, (e) => received.push(e))
  t.after(() => unsubscribe())
  const edited = await api(s.base, "/api/conversations/" + c.cid + "/messages/" + mid + "/edit", {
    token: c.alice.token,
    body: { ciphertext: "second-blob" },
  })
  assert.equal(edited.status, 200)
  assert.equal(edited.json.message.ciphertext, "second-blob")
  assert.ok(edited.json.message.editedAt)
  const updates = received.filter((event) => event.type === "message.updated")
  assert.equal(updates.length, 1)
})

test("a member who is not the author cannot edit or delete", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await direct(s.base)
  const mid = await post(s.base, c.alice.token, c.cid, "mine")
  const edit = await api(s.base, "/api/conversations/" + c.cid + "/messages/" + mid + "/edit", {
    token: c.bob.token,
    body: { ciphertext: "hijacked" },
  })
  assert.equal(edit.status, 403)
  const del = await api(s.base, "/api/conversations/" + c.cid + "/messages/" + mid + "/delete", {
    token: c.bob.token,
    body: {},
  })
  assert.equal(del.status, 403)
})

test("deleting a message clears its ciphertext and marks it deleted", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await direct(s.base)
  const mid = await post(s.base, c.alice.token, c.cid, "regret")
  const received: any[] = []
  const unsubscribe = s.app.bus.subscribeUser(c.bob.user.id, (e) => received.push(e))
  t.after(() => unsubscribe())
  const del = await api(s.base, "/api/conversations/" + c.cid + "/messages/" + mid + "/delete", {
    token: c.alice.token,
    body: {},
  })
  assert.equal(del.status, 200)
  const deletions = received.filter((event) => event.type === "message.deleted")
  assert.equal(deletions.length, 1)
  const list = await api(s.base, "/api/conversations/" + c.cid + "/messages", { token: c.bob.token })
  assert.equal(list.json.messages.length, 1)
  assert.equal(list.json.messages[0].ciphertext, "")
  assert.ok(list.json.messages[0].deletedAt)
})

test("reactions can be added, listed, and removed", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await direct(s.base)
  const mid = await post(s.base, c.alice.token, c.cid, "nice one")
  const add = await api(s.base, "/api/conversations/" + c.cid + "/messages/" + mid + "/reactions", {
    token: c.bob.token,
    body: { emoji: "thumbsup", active: true },
  })
  assert.equal(add.status, 200)
  const listed = await api(s.base, "/api/conversations/" + c.cid + "/reactions", { token: c.alice.token })
  assert.equal(listed.json.reactions.length, 1)
  assert.equal(listed.json.reactions[0].emoji, "thumbsup")
  assert.equal(listed.json.reactions[0].userId, c.bob.user.id)
  assert.equal(listed.json.reactions[0].messageId, mid)
  const removed = await api(s.base, "/api/conversations/" + c.cid + "/messages/" + mid + "/reactions", {
    token: c.bob.token,
    body: { emoji: "thumbsup", active: false },
  })
  assert.equal(removed.status, 200)
  const after = await api(s.base, "/api/conversations/" + c.cid + "/reactions", { token: c.alice.token })
  assert.equal(after.json.reactions.length, 0)
})

test("typing is broadcast only to the other members", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await direct(s.base)
  const bobEvents: any[] = []
  const aliceEvents: any[] = []
  const u1 = s.app.bus.subscribeUser(c.bob.user.id, (e) => bobEvents.push(e))
  const u2 = s.app.bus.subscribeUser(c.alice.user.id, (e) => aliceEvents.push(e))
  t.after(() => {
    u1()
    u2()
  })
  const r = await api(s.base, "/api/conversations/" + c.cid + "/typing", { token: c.alice.token, body: {} })
  assert.equal(r.status, 202)
  const bobTyping = bobEvents.filter((event) => event.type === "typing")
  assert.equal(bobTyping.length, 1)
  assert.equal(bobTyping[0].userId, c.alice.user.id)
  assert.equal(aliceEvents.filter((event) => event.type === "typing").length, 0)
})

test("history returns the newest page and walks back with a cursor", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const c = await direct(s.base)
  const ids: string[] = []
  for (const label of ["m1", "m2", "m3", "m4", "m5"]) {
    ids.push(await post(s.base, c.alice.token, c.cid, label))
    await sleep(2)
  }
  const page1 = await api(s.base, "/api/conversations/" + c.cid + "/messages?limit=2", { token: c.bob.token })
  assert.equal(page1.status, 200)
  assert.equal(page1.json.messages.length, 2)
  assert.equal(page1.json.messages[0].id, ids[3])
  assert.equal(page1.json.messages[1].id, ids[4])
  assert.equal(page1.json.hasMore, true)
  const page2 = await api(s.base, "/api/conversations/" + c.cid + "/messages?limit=2&before=" + ids[3], {
    token: c.bob.token,
  })
  assert.equal(page2.json.messages.length, 2)
  assert.equal(page2.json.messages[0].id, ids[1])
  assert.equal(page2.json.messages[1].id, ids[2])
})