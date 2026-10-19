import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { connect, type Socket } from "node:net"
import { createApp } from "../src/app"
import { attachWebSocket, type WebSocketOptions } from "../src/ws"
import { api, directConversation } from "./helpers"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function startWsServer(options: WebSocketOptions = {}, callReconnectGraceMs = 0) {
  const app = createApp({ callReconnectGraceMs })
  const server: Server = createServer(app.listener)
  attachWebSocket(server, app, options)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

// A bare TCP client that completes the WebSocket handshake and then does
// nothing: no pongs, no close frame - like a browser that was killed.
function rawSocket(port: number, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    sock.once("data", (chunk) => (String(chunk).startsWith("HTTP/1.1 101") ? resolve(sock) : reject(new Error(String(chunk)))))
    sock.on("error", () => undefined)
  })
}

const callOf = async (base: string, token: string, cid: string) => (await api(base, `/api/conversations/${cid}/call`, { token })).json.call
const onlineIds = async (base: string, token: string, cid: string): Promise<string[]> => (await api(base, `/api/conversations/${cid}/presence`, { token })).json.onlineUserIds

test("a client that closes its side of the socket leaves calls and goes offline", async () => {
  const s = await startWsServer()
  try {
    const { a, b, cid } = await directConversation(s.base, "drop_a", "drop_b")
    const sock = await rawSocket(s.port, a.token)
    await api(s.base, `/api/conversations/${cid}/call/join`, { token: a.token, body: {} })
    assert.ok(await callOf(s.base, b.token, cid), "a is in the call")
    assert.ok((await onlineIds(s.base, b.token, cid)).includes(a.user.id))
    sock.end()
    await delay(300)
    assert.equal(await callOf(s.base, b.token, cid), null, "the call ends with a's last connection")
    assert.equal((await onlineIds(s.base, b.token, cid)).includes(a.user.id), false, "a is offline")
    sock.destroy()
  } finally {
    await s.close()
  }
})

test("a socket that stops answering pings is dropped; a live one stays", async () => {
  const s = await startWsServer({ pingIntervalMs: 60, idleLimitMs: 200 })
  try {
    const { a, b, cid } = await directConversation(s.base, "idle_a", "idle_b")
    const dead = await rawSocket(s.port, a.token)
    await api(s.base, `/api/conversations/${cid}/call/join`, { token: a.token, body: {} })
    const live = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${encodeURIComponent(b.token)}`)
    await new Promise((resolve) => live.addEventListener("open", resolve, { once: true }))
    await delay(600)
    assert.equal(await callOf(s.base, b.token, cid), null, "the silent socket was dropped and a left the call")
    assert.ok((await onlineIds(s.base, a.token, cid)).includes(b.user.id), "the socket that answers pings is still connected")
    live.close()
    dead.destroy()
  } finally {
    await s.close()
  }
})

test("a dropped connection keeps its place in the call while it comes back", async () => {
  const s = await startWsServer({}, 400)
  try {
    const { a, b, cid } = await directConversation(s.base, "grace_a", "grace_b")
    const first = await rawSocket(s.port, a.token)
    await api(s.base, `/api/conversations/${cid}/call/join`, { token: a.token, body: {} })
    first.end()
    await delay(150)
    assert.ok(await callOf(s.base, b.token, cid), "still in the call right after the drop")
    const second = await rawSocket(s.port, a.token)
    await delay(600)
    assert.deepEqual((await callOf(s.base, b.token, cid))?.participants, [a.user.id], "reconnected in time: the call goes on")
    second.end()
    await delay(700)
    assert.equal(await callOf(s.base, b.token, cid), null, "gone for longer than the grace period: the call ends")
    first.destroy()
    second.destroy()
  } finally {
    await s.close()
  }
})
