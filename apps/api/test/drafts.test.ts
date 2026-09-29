import { test } from "node:test"
import assert from "node:assert/strict"
import { api, befriend, registerUser, startTestServer } from "./helpers"

test("encrypted drafts are private, durable, synchronized to the owner, and clearable", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  const bob = await registerUser(s.base, "bob")
  const outsider = await registerUser(s.base, "outsider")
  await befriend(s.base, alice, bob)
  const created = await api(s.base, "/api/conversations", { token: alice.token, body: { kind: "group", title: "Drafts", memberUsernames: ["bob"] } })
  const id = created.json.conversation.id as string
  const ownerEvents: any[] = []
  const unsubscribe = s.app.bus.subscribeUser(alice.user.id, (event) => ownerEvents.push(event))
  t.after(unsubscribe)

  const opaque = "fx1.opaque-ciphertext-without-plaintext"
  const saved = await api(s.base, `/api/conversations/${id}/draft`, { token: alice.token, body: { ciphertext: opaque } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.draft.ciphertext, opaque)
  const draftUpdates = ownerEvents.filter((event) => event.type === "draft.updated")
  assert.equal(draftUpdates.length, 1)
  assert.equal(draftUpdates[0].ciphertext, opaque)

  const mine = await api(s.base, `/api/conversations/${id}/draft`, { token: alice.token })
  assert.equal(mine.json.draft.ciphertext, opaque)
  const bobs = await api(s.base, `/api/conversations/${id}/draft`, { token: bob.token })
  assert.equal(bobs.status, 200)
  assert.equal(bobs.json.draft, null)
  const denied = await api(s.base, `/api/conversations/${id}/draft`, { token: outsider.token })
  assert.equal(denied.status, 403)

  const cleared = await api(s.base, `/api/conversations/${id}/draft`, { token: alice.token, body: { ciphertext: null } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.draft, null)
  const after = await api(s.base, `/api/conversations/${id}/draft`, { token: alice.token })
  assert.equal(after.json.draft, null)
})

test("oversized encrypted drafts are rejected", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  const created = await api(s.base, "/api/conversations", { token: alice.token, body: { kind: "group", title: "Solo" } })
  const result = await api(s.base, `/api/conversations/${created.json.conversation.id}/draft`, { token: alice.token, body: { ciphertext: "x".repeat(131073) } })
  assert.equal(result.status, 413)
})