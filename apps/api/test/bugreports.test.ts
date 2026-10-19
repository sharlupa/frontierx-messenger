import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import { api, registerUser, startTestServer } from "./helpers"
import { formatBugReport, sanitizeDiagnostics } from "../src/bugreports"

// A stand-in for api.telegram.org that records what the bot sends.
async function fakeTelegram() {
  const calls: Array<{ method: string; contentType: string; body: string }> = []
  let failing = false
  let nextId = 100
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const method = (req.url ?? "").split("/").pop() ?? ""
    calls.push({ method, contentType: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") })
    res.setHeader("content-type", "application/json")
    if (failing) {
      res.statusCode = 502
      res.end(JSON.stringify({ ok: false, description: "Bad Gateway" }))
      return
    }
    res.end(JSON.stringify({ ok: true, result: { message_id: nextId++ } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    calls,
    target: { token: "123:test", chatId: "4242", apiBase: `http://127.0.0.1:${port}` },
    setFailing: (value: boolean) => { failing = value },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// A 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

test("a bug report reaches Telegram with its details and screenshot, and the screenshot is not kept (one screenshot, as older builds send it)", async (t) => {
  const tg = await fakeTelegram()
  const s = await startTestServer({ bugReportTarget: tg.target })
  t.after(async () => { await s.close(); await tg.close() })
  const u = await registerUser(s.base, "reporter")
  const res = await api(s.base, "/api/bug-reports", {
    token: u.token,
    body: {
      text: "Звонок обрывается\u0007 при переходе в другой чат",
      screenshot: PNG,
      diagnostics: { version: "0.3.0", build: "2026-10-14T12:00:00Z", platform: "Android", userAgent: "UA", secret: "dropped", errors: ["TypeError: x is undefined", 5] },
    },
  })
  assert.equal(res.status, 201)
  const id = res.json.id as string
  await until(() => Boolean(s.app.store.getBugReport(id)?.deliveredAt))

  assert.deepEqual(tg.calls.map((c) => c.method), ["sendMessage", "sendMessage", "sendPhoto"])
  // First a separator of its own, sent without a sound.
  const separator = JSON.parse(tg.calls[0].body) as { chat_id: string; text: string; disable_notification?: boolean }
  assert.equal(separator.chat_id, "4242")
  assert.equal(separator.disable_notification, true)
  assert.ok(separator.text.includes(id) && separator.text.includes("━"))
  const message = JSON.parse(tg.calls[1].body) as { chat_id: string; text: string; parse_mode?: string; disable_notification?: boolean }
  assert.equal(message.disable_notification, undefined, "the report itself makes the sound")
  assert.equal(message.chat_id, "4242")
  assert.equal(message.parse_mode, undefined, "plain text, so nothing typed turns into markup")
  assert.ok(message.text.includes(id))
  assert.ok(message.text.includes("@reporter"))
  assert.ok(message.text.includes("Звонок обрывается при переходе в другой чат"), "control characters are dropped")
  assert.ok(message.text.includes("0.3.0") && message.text.includes("Android") && message.text.includes("TypeError: x is undefined"))
  assert.ok(!message.text.includes("dropped"), "unknown diagnostic fields are not forwarded")
  assert.ok(tg.calls[2].contentType.startsWith("multipart/form-data"))
  assert.ok(tg.calls[2].body.includes('"message_id":101'), "the screenshot replies to the report, not to the separator")
  const row = s.app.store.getBugReport(id)
  assert.deepEqual(row?.screenshots, [], "the screenshot is dropped once delivered")
  assert.equal(row?.lastError, null)
})

test("several screenshots go as one album replying to the report", async (t) => {
  const tg = await fakeTelegram()
  const s = await startTestServer({ bugReportTarget: tg.target })
  t.after(async () => { await s.close(); await tg.close() })
  const u = await registerUser(s.base, "album")
  const res = await api(s.base, "/api/bug-reports", { token: u.token, body: { text: "three pictures", screenshots: [PNG, PNG, PNG] } })
  assert.equal(res.status, 201)
  const id = res.json.id as string
  assert.equal(s.app.store.getBugReport(id)?.screenshots.length, 3, "stored until delivered")
  await until(() => Boolean(s.app.store.getBugReport(id)?.deliveredAt))
  assert.deepEqual(tg.calls.map((c) => c.method), ["sendMessage", "sendMessage", "sendMediaGroup"])
  const album = tg.calls[2].body
  assert.ok(album.includes("attach://shot0") && album.includes("attach://shot2") && !album.includes("attach://shot3"))
  assert.ok(album.includes('"message_id":101'), "the album replies to the report")
  assert.ok(album.includes("(3)"), "the caption counts the pictures")
  assert.deepEqual(s.app.store.getBugReport(id)?.screenshots, [], "all of them are dropped once delivered")
})

test("reports are checked and limited", async (t) => {
  const s = await startTestServer({ bugReportTarget: null })
  t.after(() => s.close())
  const u = await registerUser(s.base, "checker")
  const send = (body: unknown, token: string | null = u.token) => api(s.base, "/api/bug-reports", { token: token ?? undefined, body })
  assert.equal((await send({ text: "it broke" }, null)).status, 401)
  assert.equal((await send({ text: "  " })).status, 400)
  assert.equal((await send({ text: "x".repeat(3001) })).status, 400)
  assert.equal((await send({ text: "svg", screenshot: "data:image/svg+xml;base64,PHN2Zy8+" })).status, 400)
  assert.equal((await send({ text: "not an image", screenshot: "hello" })).status, 400)
  assert.equal((await send({ text: "not a list", screenshots: "hello" })).status, 400)
  assert.equal((await send({ text: "six", screenshots: [PNG, PNG, PNG, PNG, PNG, PNG] })).status, 400, "at most five")
  const big = "data:image/jpeg;base64," + Buffer.alloc(2600 * 1024).toString("base64")
  assert.equal((await send({ text: "heavy", screenshots: [big, big, big, big] })).status, 400, "at most 10 MB together")
  // Five accepted an hour, then the person is asked to wait.
  for (let i = 0; i < 5; i++) assert.equal((await send({ text: "report " + i })).status, 201)
  assert.equal((await send({ text: "one more" })).status, 429)
})

test("without a bot the reports wait, and go out once Telegram answers again", async (t) => {
  const tg = await fakeTelegram()
  const s = await startTestServer({ bugReportTarget: tg.target })
  t.after(async () => { await s.close(); await tg.close() })
  const u = await registerUser(s.base, "patient")
  tg.setFailing(true)
  const res = await api(s.base, "/api/bug-reports", { token: u.token, body: { text: "Telegram is down" } })
  assert.equal(res.status, 201)
  const id = res.json.id as string
  await until(() => (s.app.store.getBugReport(id)?.attempts ?? 0) === 1)
  const failed = s.app.store.getBugReport(id)
  assert.equal(failed?.deliveredAt, null)
  assert.ok(failed?.lastError?.includes("Bad Gateway"))
  assert.ok(Date.parse(failed?.nextAttemptAt ?? "") > Date.now(), "the next attempt waits")
  // Not due yet: nothing is sent.
  tg.setFailing(false)
  assert.equal(await s.app.deliverBugReports(), 0)
  // Due a few minutes later: delivered.
  assert.equal(await s.app.deliverBugReports(Date.now() + 5 * 60000), 1)
  assert.ok(s.app.store.getBugReport(id)?.deliveredAt)
})

test("reports of a deleted account are deleted with it", async (t) => {
  const s = await startTestServer({ bugReportTarget: null })
  t.after(() => s.close())
  const u = await registerUser(s.base, "leaving")
  const res = await api(s.base, "/api/bug-reports", { token: u.token, body: { text: "bye" } })
  s.app.store.deleteUserAccount(u.user.id)
  assert.equal(s.app.store.getBugReport(res.json.id), null)
})

test("the message fits Telegram's limit and keeps the details", () => {
  const text = formatBugReport({
    id: "bug_1",
    text: "a".repeat(5000),
    diagnostics: sanitizeDiagnostics({ version: "1", platform: "Linux", errors: Array.from({ length: 30 }, (_, i) => "error " + i) }),
    createdAt: "2026-10-14T12:00:00.000Z",
    reporter: { id: "user_1", username: "u", displayName: "U" },
    screenshot: null,
  })
  assert.ok(text.length <= 4096)
  assert.ok(text.includes("…"))
  assert.ok(text.includes("Linux") && text.includes("error 29") && !text.includes("error 19\n"), "only the last ten errors")
})
