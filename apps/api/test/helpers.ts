import { createServer, type Server } from "node:http"
import { createApp, type App, type CreateAppOptions } from "../src/app"

// Shared helpers for API tests: boot an isolated in-memory app on an ephemeral
// port and talk to it over real HTTP with fetch. This file lives under test/ but
// declares no test() cases, so the runner simply loads it with zero tests.

export interface TestServer {
  app: App
  server: Server
  base: string
  close: () => Promise<void>
}

export async function startTestServer(options: CreateAppOptions = {}): Promise<TestServer> {
  const app = createApp(options)
  const server = createServer(app.listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    app,
    server,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface ApiResponse<T = any> {
  status: number
  json: T
}

export async function api<T = any>(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers["content-type"] = "application/json"
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET")
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

export async function registerUser(
  base: string,
  username: string,
  password = "password123",
): Promise<{ token: string; user: { id: string; username: string; displayName: string } }> {
  const r = await api(base, "/api/auth/register", { body: { username, password, displayName: username } })
  return r.json
}

export interface RegisteredUser {
  token: string
  user: { id: string; username: string; displayName: string }
}

// Establishes a direct conversation the way the product now requires: through a
// mutual friend request. The first request stays pending; the reverse request
// from the other user is auto-accepted by the API, which creates the direct
// conversation and returns it.
export async function directConversation(
  base: string,
  aName: string,
  bName: string,
  password = "password123",
): Promise<{ a: RegisteredUser; b: RegisteredUser; cid: string }> {
  const a = await registerUser(base, aName, password)
  const b = await registerUser(base, bName, password)
  await api(base, "/api/friends/requests", { token: a.token, body: { username: bName } })
  const accepted = await api(base, "/api/friends/requests", { token: b.token, body: { username: aName } })
  return { a, b, cid: accepted.json.conversation.id as string }
}
// Group members have to be friends of whoever adds them; this makes two
// registered users friends the way the product does (mutual requests).
export async function befriend(base: string, a: { token: string; user: { username: string } }, b: { token: string; user: { username: string } }): Promise<string> {
  await api(base, "/api/friends/requests", { token: a.token, body: { username: b.user.username } })
  const accepted = await api(base, "/api/friends/requests", { token: b.token, body: { username: a.user.username } })
  return accepted.json.conversation.id as string
}
