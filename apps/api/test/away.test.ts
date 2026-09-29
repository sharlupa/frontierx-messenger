import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { createApp } from "../src/app"
import { attachWebSocket } from "../src/ws"
import { api, directConversation, startTestServer } from "./helpers"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function presenceOf(base: string, token: string, conversationId: string) {
  return (await api(base, `/api/conversations/${conversationId}/presence`, { token })).json as { onlineUserIds: string[]; lastSeen: Record<string, string> }
}

test("stepping away hides the online status but keeps the connection and the call", async () => {
  const s = await startTestServer()
  try {
    const { a, b, cid } = await directConversation(s.base, "away_a", "away_b")
    const sub = s.app.bus.subscribeUser(b.user.id, () => {})
    assert.ok((await presenceOf(s.base, a.token, cid)).onlineUserIds.includes(b.user.id), "b is online while looking at the app")

    const join = await api(s.base, `/api/conversations/${cid}/call/join`, { token: b.token, body: {} })
    assert.equal(join.status, 200)

    sub.setPresence(false)
    const away = await presenceOf(s.base, a.token, cid)
    assert.equal(away.onlineUserIds.includes(b.user.id), false, "away: not shown online")
    assert.ok(away.lastSeen[b.user.id], "stepping away counts as the last visit")
    const call = (await api(s.base, `/api/conversations/${cid}/call`, { token: a.token })).json.call
    assert.ok(call && call.participants.includes(b.user.id), "the call carries on while b is in another tab")

    sub.setPresence(true)
    assert.ok((await presenceOf(s.base, a.token, cid)).onlineUserIds.includes(b.user.id), "back: online again")

    sub()
    assert.equal((await api(s.base, `/api/conversations/${cid}/call`, { token: a.token })).json.call, null, "closing the last connection ends the call")
  } finally {
    await s.close()
  }
})

async function startWsServer() {
  const app = createApp()
  const server: Server = createServer(app.listener)
  attachWebSocket(server, app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

async function until(check: () => Promise<boolean>, what: string, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await delay(100)
  }
  assert.fail("timed out waiting for " + what)
}

test("clients report being away over the socket, rate-limited, latest wish wins", async () => {
  const s = await startWsServer()
  const { a, b, cid } = await directConversation(s.base, "awaysock_a", "awaysock_b")
  const socket = new WebSocket(`${s.wsBase}/ws?token=${encodeURIComponent(b.token)}`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (ev) => { if (String(ev.data).includes('"ready"')) resolve() })
      socket.addEventListener("error", () => reject(new Error("socket error")))
    })
    const online = async () => (await presenceOf(s.base, a.token, cid)).onlineUserIds.includes(b.user.id)
    await until(online, "b online")

    socket.send(JSON.stringify({ type: "presence", active: false }))
    await until(async () => !(await online()), "b away")

    socket.send(JSON.stringify({ type: "presence", active: true }))
    await until(online, "b back")

    // A burst of changes settles on the last one.
    for (const active of [false, true, false, true, false]) socket.send(JSON.stringify({ type: "presence", active }))
    await delay(1500)
    assert.equal(await online(), false, "the final state of a burst is applied")

    // Anything else sent over the socket is ignored.
    socket.send("not json")
    socket.send(JSON.stringify({ type: "presence", active: "yes" }))
    await delay(1200)
    assert.equal(await online(), false)
  } finally {
    socket.close()
    await s.close()
  }
})
