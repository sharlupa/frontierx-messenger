import { test } from "node:test"
import assert from "node:assert/strict"
import type { WsEvent } from "@frontierx/protocol"
import { api, directConversation, startTestServer } from "./helpers"

test("presence changes only on a user's first and last live subscription", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { a: alice, b: bob, cid: conversationId } = await directConversation(s.base, "alice_presence_bus", "bob_presence_bus")

  const seen: WsEvent[] = []
  const unsubscribeAlice = s.app.bus.subscribeUser(alice.user.id, (event) => seen.push(event))
  t.after(unsubscribeAlice)
  const unsubscribeBobFirst = s.app.bus.subscribeUser(bob.user.id, () => {})
  t.after(unsubscribeBobFirst)

  const onlineEvents = () => seen.filter(
    (event) => event.type === "presence.updated" && event.conversationId === conversationId && event.userId === bob.user.id && event.online,
  )
  const offlineEvents = () => seen.filter(
    (event) => event.type === "presence.updated" && event.conversationId === conversationId && event.userId === bob.user.id && !event.online,
  )
  assert.equal(onlineEvents().length, 1)

  const snapshot = await api(s.base, `/api/conversations/${conversationId}/presence`, { token: alice.token })
  assert.equal(snapshot.status, 200)
  assert.deepEqual(new Set(snapshot.json.onlineUserIds), new Set([alice.user.id, bob.user.id]))

  const unsubscribeBobSecond = s.app.bus.subscribeUser(bob.user.id, () => {})
  t.after(unsubscribeBobSecond)
  assert.equal(onlineEvents().length, 1)
  unsubscribeBobFirst()
  assert.equal(s.app.bus.isUserOnline(bob.user.id), true)
  assert.equal(offlineEvents().length, 0)

  unsubscribeBobSecond()
  assert.equal(s.app.bus.isUserOnline(bob.user.id), false)
  assert.equal(offlineEvents().length, 1)
})