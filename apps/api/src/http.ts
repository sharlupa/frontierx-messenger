import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpError } from "./errors.js"

// Minimal zero-dependency router and JSON helpers. Enough for M1; the shape is
// deliberately close to common frameworks so swapping to Fastify later is
// mechanical (see docs/ARCHITECTURE.md).

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  method: string
  path: string
  query: URLSearchParams
  params: Record<string, string>
  userId?: string
}

export type Handler = (ctx: Ctx) => void | Promise<void>

interface Route {
  method: string
  segments: string[]
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler })
  }
  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler)
  }
  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler)
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = path.split("/").filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== segs.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const rs = route.segments[i]
        const seg = segs[i]
        if (rs.startsWith(":")) params[rs.slice(1)] = decodeURIComponent(seg)
        else if (rs !== seg) {
          matched = false
          break
        }
      }
      if (matched) return { handler: route.handler, params }
    }
    return null
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(data)
}

export async function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  limitBytes = 2_000_000,
): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limitBytes) throw new HttpError(413, "payload too large")
    chunks.push(buf)
  }
  if (chunks.length === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

export async function readRawBody(
  req: IncomingMessage,
  limitBytes = 2147483648,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limitBytes) throw new HttpError(413, "payload too large")
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(bytes.length),
  })
  res.end(bytes)
}
