import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { createApp } from "../src/app"
import { attachWebSocket } from "../src/ws"
import { api, registerUser, directConversation } from "./helpers"

// A WebSocket-enabled variant of startTestServer: the same isolated in-memory
// app, but with the upgrade handler attached so realtime delivery can be tested
// end to end over a real socket on an ephemeral port.
//
// close() force-closes any live connections before closing the server so a
// still-open socket can never make teardown block forever.
async function startWsServer(): Promise<{ base: string; wsBase: string; close: () => Promise<void> }> {
  const app = createApp()
  const server: Server = createServer(app.listener)
  attachWebSocket(server, app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

interface Waiter {
  predicate: (value: any) => boolean
  resolve: (value: any) => void
  timer: ReturnType<typeof setTimeout>
}

// Buffers every decoded message from the moment the socket is constructed, so a
// frame that arrives before a test asks for it (e.g. the initial "ready") is
// never dropped in a listener-registration race. Every wait is bounded by a
// timeout so a broken server surfaces as a fast failure, never a hang.
//
// IMPORTANT: call close() before the test body returns. An open client socket
// keeps a live handle in the node:test worker process, which would prevent the
// worker from exiting and stall the whole run.
class SocketClient {
  readonly opened: Promise<void>
  private readonly ws: WebSocket
  private readonly queue: any[] = []
  private readonly waiters: Waiter[] = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws did not open in time")), 5000)
      this.ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws connection error"))
      })
    })
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      let data: any
      try {
        data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data))
      } catch {
        return
      }
      const idx = this.waiters.findIndex((w) => w.predicate(data))
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1)
        clearTimeout(w.timer)
        w.resolve(data)
      } else {
        this.queue.push(data)
      }
    })
  }

  next(predicate: (value: any) => boolean, timeoutMs = 5000): Promise<any> {
    const idx = this.queue.findIndex(predicate)
    if (idx >= 0) {
      const [value] = this.queue.splice(idx, 1)
      return Promise.resolve(value)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error("timed out waiting for a matching ws message"))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, timer })
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {}
  }
}

test("ws handshake is rejected without a valid token", async (t) => {
  const s = await startWsServer()
  t.after(() => s.close())
  const client = new SocketClient(`${s.wsBase}/ws?token=not-a-real-token`)
  t.after(() => client.close())
  await assert.rejects(client.opened)
  client.close()
})

test("an authenticated socket receives ready then message.created in realtime", async (t) => {
  const s = await startWsServer()
  t.after(() => s.close())
  const { a: alice, b: bob, cid: conversationId } = await directConversation(s.base, "alice_ws", "bob_ws")

  const client = new SocketClient(`${s.wsBase}/ws?token=${bob.token}`)
  t.after(() => client.close())
  await client.opened

  const ready = await client.next((v) => v.type === "ready")
  assert.equal(ready.userId, bob.user.id)

  const post = await api(s.base, `/api/conversations/${conversationId}/messages`, {
    token: alice.token,
    body: { ciphertext: "cipher-over-the-wire" },
  })
  assert.equal(post.status, 201)

  const event = await client.next((v) => v.type === "message.created")
  assert.equal(event.message.ciphertext, "cipher-over-the-wire")
  assert.equal(event.message.conversationId, conversationId)

  // Release the socket handle so the node:test worker can exit cleanly.
  client.close()
})

test("member presence is delivered over WebSocket and hidden from non-members", async (t) => {
  const s = await startWsServer()
  t.after(() => s.close())
  const { a: alice, b: bob, cid: conversationId } = await directConversation(s.base, "alice_presence", "bob_presence")
  const carol = await registerUser(s.base, "carol_presence")

  const aliceClient = new SocketClient(`${s.wsBase}/ws?token=${alice.token}`)
  const carolClient = new SocketClient(`${s.wsBase}/ws?token=${carol.token}`)
  t.after(() => aliceClient.close())
  t.after(() => carolClient.close())
  await aliceClient.opened
  await carolClient.opened
  await aliceClient.next((value) => value.type === "ready")
  await carolClient.next((value) => value.type === "ready")

  const beforeBob = await api(s.base, `/api/conversations/${conversationId}/presence`, { token: alice.token })
  assert.equal(beforeBob.status, 200)
  assert.deepEqual(beforeBob.json.onlineUserIds, [alice.user.id])
  const forbidden = await api(s.base, `/api/conversations/${conversationId}/presence`, { token: carol.token })
  assert.equal(forbidden.status, 403)

  const bobClient = new SocketClient(`${s.wsBase}/ws?token=${bob.token}`)
  t.after(() => bobClient.close())
  await bobClient.opened
  await bobClient.next((value) => value.type === "ready")
  const online = await aliceClient.next(
    (value) => value.type === "presence.updated" && value.conversationId === conversationId && value.userId === bob.user.id && value.online === true,
  )
  assert.equal(online.userId, bob.user.id)
  await assert.rejects(carolClient.next((value) => value.type === "presence.updated" && value.userId === bob.user.id, 180))

  const snapshot = await api(s.base, `/api/conversations/${conversationId}/presence`, { token: alice.token })
  assert.equal(snapshot.status, 200)
  assert.deepEqual(new Set(snapshot.json.onlineUserIds), new Set([alice.user.id, bob.user.id]))

  // Release all socket handles so the node:test worker can exit cleanly.
  aliceClient.close()
  carolClient.close()
  bobClient.close()
})