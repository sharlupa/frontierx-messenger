import { test } from "node:test"
import assert from "node:assert/strict"
import { api, directConversation, startTestServer } from "./helpers"

test("a participant's microphone state reaches the others in the call", async () => {
  const s = await startTestServer()
  try {
    const { a, b, cid } = await directConversation(s.base, "mute_a", "mute_b")
    const events: Array<{ type: string; userId?: string; muted?: boolean | string[] }> = []
    s.app.bus.subscribeUser(a.user.id, (event) => events.push(event as never), { presence: false })

    assert.equal((await api(s.base, `/api/conversations/${cid}/call/mute`, { token: b.token, body: { muted: true } })).status, 409, "not in the call yet")
    await api(s.base, `/api/conversations/${cid}/call/join`, { token: a.token, body: {} })
    const joined = await api(s.base, `/api/conversations/${cid}/call/join`, { token: b.token, body: {} })
    assert.deepEqual(joined.json.call.muted, [])

    assert.equal((await api(s.base, `/api/conversations/${cid}/call/mute`, { token: b.token, body: { muted: "yes" } })).status, 400)
    const off = await api(s.base, `/api/conversations/${cid}/call/mute`, { token: b.token, body: { muted: true } })
    assert.equal(off.status, 200)
    const told = events.filter((e) => e.type === "call.mute").pop()
    assert.equal(told?.userId, b.user.id)
    assert.equal(told?.muted, true)
    assert.deepEqual((await api(s.base, `/api/conversations/${cid}/call`, { token: a.token })).json.call.muted, [b.user.id], "late joiners learn it from the call state")

    await api(s.base, `/api/conversations/${cid}/call/mute`, { token: b.token, body: { muted: false } })
    assert.equal(events.filter((e) => e.type === "call.mute").pop()?.muted, false)

    // Leaving and coming back starts with the microphone on again.
    await api(s.base, `/api/conversations/${cid}/call/mute`, { token: b.token, body: { muted: true } })
    await api(s.base, `/api/conversations/${cid}/call/leave`, { token: b.token, body: {} })
    const back = await api(s.base, `/api/conversations/${cid}/call/join`, { token: b.token, body: {} })
    assert.deepEqual(back.json.call.muted, [])
  } finally {
    await s.close()
  }
})
