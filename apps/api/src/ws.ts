import type { Server, IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { createHash } from "node:crypto"
import { authenticate } from "./auth.js"
import type { App } from "./app.js"

// Minimal, dependency-free RFC 6455 WebSocket endpoint mounted at /ws on top of
// an existing node:http server. Authentication reuses the REST bearer session
// tokens, supplied as ?token=... on the handshake URL (browsers cannot set an
// Authorization header on a WebSocket handshake). Each socket subscribes to its
// user's stream on the shared EventBus and forwards events as JSON text frames.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
// Clients only send pings, close frames and tiny presence messages, so anything
// this large is abuse: without a cap one socket could make the process buffer
// gigabytes.
const MAX_BUFFERED_BYTES = 64 * 1024
// Each presence change is fanned out to every chat partner, so a connection
// can change it at most once a second; the latest wish always wins.
const PRESENCE_MIN_INTERVAL_MS = 1000

function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64")
}

export function attachWebSocket(server: Server, app: App): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, _head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/ws") {
      socket.destroy()
      return
    }
    const key = req.headers["sec-websocket-key"]
    if (typeof key !== "string") {
      socket.destroy()
      return
    }
    let userId: string
    try {
      userId = authenticate(app.store, `Bearer ${url.searchParams.get("token") ?? ""}`)
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n")
    socket.write(responseHeaders)

    const conn = new WsConnection(socket, userId)
    const countsPresence = url.searchParams.get("presence") !== "0"
    const subscription = app.bus.subscribeUser(userId, (event) => conn.sendJson(event), { presence: countsPresence })
    conn.onClose = subscription
    conn.onPresence = (active) => subscription.setPresence(active)
    conn.start()
    conn.sendJson({ type: "ready", userId })
  })
}

interface Frame {
  opcode: number
  payload: Buffer
}

class WsConnection {
  onClose: () => void = () => {}
  onPresence: (active: boolean) => void = () => {}
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false
  private presenceWanted: boolean | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private presenceAppliedAt = 0

  constructor(
    private readonly socket: Duplex,
    readonly userId: string,
  ) {}

  start(): void {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk))
    this.socket.on("close", () => this.handleClose())
    this.socket.on("error", () => this.handleClose())
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    this.presenceTimer = null
    this.onClose()
  }

  // The client says whether the person is looking at the app (tab visible
  // and focused) or has stepped away; only that is accepted from clients.
  private handleText(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message || typeof message !== "object") return
    const { type, active } = message as { type?: unknown; active?: unknown }
    if (type === "presence" && typeof active === "boolean") this.requestPresence(active)
  }

  private requestPresence(active: boolean): void {
    this.presenceWanted = active
    if (this.presenceTimer) return
    const wait = Math.max(0, this.presenceAppliedAt + PRESENCE_MIN_INTERVAL_MS - Date.now())
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      if (this.closed || this.presenceWanted === null) return
      this.presenceAppliedAt = Date.now()
      this.onPresence(this.presenceWanted)
    }, wait)
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    if (this.buffer.length + chunk.length > MAX_BUFFERED_BYTES) {
      // 1009: message too big.
      const code = Buffer.alloc(2)
      code.writeUInt16BE(1009, 0)
      this.sendFrame(0x8, code)
      this.socket.destroy()
      this.handleClose()
      return
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    let frame = this.readFrame()
    while (frame !== null) {
      if (frame.opcode === 0x8) {
        // close
        this.sendFrame(0x8, Buffer.alloc(0))
        this.socket.end()
        this.handleClose()
        return
      }
      if (frame.opcode === 0x9) {
        // ping -> pong
        this.sendFrame(0xa, frame.payload)
      }
      // 0x1 text: the only message clients send over the socket is their
      // presence (everything else goes through the REST API). Continuation
      // frames are drained and ignored.
      if (frame.opcode === 0x1) this.handleText(frame.payload.toString("utf8"))
      frame = this.readFrame()
    }
  }

  // Parse and consume one frame from the buffer, or return null when a complete
  // frame is not yet buffered. Client-to-server frames are always masked.
  private readFrame(): Frame | null {
    const buf = this.buffer
    if (buf.length < 2) return null
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      len = Number(buf.readBigUInt64BE(offset))
      offset += 8
    }
    const maskLen = masked ? 4 : 0
    if (buf.length < offset + maskLen + len) return null
    let payload: Buffer
    if (masked) {
      const mask = buf.subarray(offset, offset + 4)
      offset += 4
      payload = Buffer.alloc(len)
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4]
    } else {
      payload = Buffer.from(buf.subarray(offset, offset + len))
    }
    offset += len
    this.buffer = buf.subarray(offset)
    return { opcode, payload }
  }

  // Server-to-client frames are never masked and always single-frame (fin=1).
  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return
    const len = payload.length
    let header: Buffer
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len])
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    this.socket.write(Buffer.concat([header, payload]))
  }

  sendJson(value: unknown): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(value), "utf8"))
  }
}
