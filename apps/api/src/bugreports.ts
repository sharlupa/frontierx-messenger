// Bug reports people send from the app. Each report is stored first, so none
// is lost while Telegram is unreachable, and then forwarded to the developer
// through a Telegram bot of its own (not the VPN bot on the same host).
//
// Configure with TELEGRAM_BUG_BOT_TOKEN and TELEGRAM_BUG_CHAT_ID (the chat the
// bot writes to: the developer's own chat with the bot, or a group).
// TELEGRAM_API_BASE points elsewhere for a proxy or for tests. Without a token
// reports are only kept; they go out once one is configured.

export interface TelegramTarget {
  token: string
  chatId: string
  apiBase: string
}

export function telegramTargetFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramTarget | null {
  const token = env.TELEGRAM_BUG_BOT_TOKEN?.trim()
  const chatId = env.TELEGRAM_BUG_CHAT_ID?.trim()
  if (!token || !chatId) return null
  return { token, chatId, apiBase: (env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org").replace(/\/+$/, "") }
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export const BUG_REPORTS_PER_HOUR = 5
export const BUG_REPORT_REQUESTS_PER_HOUR_PER_IP = 30
export const BUG_REPORT_MIN_TEXT = 3
export const BUG_REPORT_MAX_TEXT = 3000
export const BUG_REPORT_MAX_SCREENSHOTS = 5
export const BUG_REPORT_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024
export const BUG_REPORT_MAX_SCREENSHOTS_BYTES = 10 * 1024 * 1024
// Room for the screenshots in base64 plus the text and diagnostics.
export const BUG_REPORT_MAX_BODY_BYTES = Math.ceil(BUG_REPORT_MAX_SCREENSHOTS_BYTES * 1.4) + 64 * 1024
// Delivered reports are deleted after this many days (their screenshots right
// after delivery).
export const BUG_REPORT_RETENTION_DAYS = envInt("BUG_REPORT_RETENTION_DAYS", 90)
// Delivery is retried with a growing pause, at most this many times.
export const BUG_REPORT_MAX_ATTEMPTS = 20
export const BUG_REPORT_MAX_RETRY_MINUTES = 60

const SCREENSHOT_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

export type Screenshot = { bytes: Buffer; type: string }

export function parseScreenshot(value: unknown): Screenshot | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") throw new Error("screenshot must be an image")
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match || !SCREENSHOT_TYPES[match[1]]) throw new Error("screenshot must be a PNG, JPEG or WebP image")
  const bytes = Buffer.from(match[2], "base64")
  if (bytes.length === 0) throw new Error("screenshot must be an image")
  if (bytes.length > BUG_REPORT_MAX_SCREENSHOT_BYTES) throw new Error("screenshot is too large")
  return { bytes, type: match[1] }
}

// The screenshots of a report body: `screenshots` (a list), or `screenshot`
// (one, as builds before the list sent it).
export function parseScreenshots(body: { screenshots?: unknown; screenshot?: unknown }): Screenshot[] {
  const values = Array.isArray(body.screenshots) ? body.screenshots : body.screenshots === undefined || body.screenshots === null ? [body.screenshot] : null
  if (!values) throw new Error("screenshots must be a list of images")
  const shots = values.map(parseScreenshot).filter((shot): shot is Screenshot => shot !== null)
  if (shots.length > BUG_REPORT_MAX_SCREENSHOTS) throw new Error("too many screenshots")
  if (shots.reduce((sum, shot) => sum + shot.bytes.length, 0) > BUG_REPORT_MAX_SCREENSHOTS_BYTES) throw new Error("screenshots are too large")
  return shots
}

// What the app may attach about itself. Anything else is dropped, and every
// value is cut short, so a report cannot smuggle in arbitrary data.
const DIAGNOSTIC_FIELDS = ["version", "build", "platform", "userAgent", "language", "screen", "viewport", "timezone", "online", "page"] as const
const DIAGNOSTIC_VALUE_MAX = 300
const DIAGNOSTIC_ERRORS_MAX = 10

export type Diagnostics = Partial<Record<(typeof DIAGNOSTIC_FIELDS)[number], string>> & { errors?: string[] }

const oneLine = (value: string, max: number): string => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max)

export function sanitizeDiagnostics(input: unknown): Diagnostics | null {
  if (!input || typeof input !== "object") return null
  const source = input as Record<string, unknown>
  const out: Diagnostics = {}
  for (const field of DIAGNOSTIC_FIELDS) {
    const value = source[field]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = oneLine(String(value), DIAGNOSTIC_VALUE_MAX)
      if (text) out[field] = text
    }
  }
  if (Array.isArray(source.errors)) {
    const errors = source.errors
      .filter((item): item is string => typeof item === "string")
      .slice(-DIAGNOSTIC_ERRORS_MAX)
      .map((item) => oneLine(item, DIAGNOSTIC_VALUE_MAX))
      .filter(Boolean)
    if (errors.length) out.errors = errors
  }
  return Object.keys(out).length ? out : null
}

export interface BugReportForDelivery {
  id: string
  text: string
  diagnostics: Diagnostics | null
  createdAt: string
  reporter: { id: string; username: string | null; displayName: string | null }
  screenshots: Screenshot[]
}

// Telegram refuses messages over 4096 characters.
const TELEGRAM_TEXT_MAX = 4096
const LABELS = {
  title: "Сообщение об ошибке",
  from: "От",
  at: "Когда",
  details: "Техническая информация",
  version: "Версия",
  build: "сборка",
  platform: "Платформа",
  userAgent: "Браузер",
  language: "Язык",
  screen: "Экран",
  viewport: "Окно",
  timezone: "Часовой пояс",
  online: "В сети",
  page: "Страница",
  errors: "Последние ошибки",
  screenshot: "Скриншот к сообщению",
  screenshots: "Скриншоты к сообщению",
  separator: "Новое сообщение об ошибке",
} as const

// A line of its own before every report, so reports stand apart in the chat.
const SEPARATOR_LINE = "━".repeat(18)
export function formatSeparator(report: Pick<BugReportForDelivery, "id">): string {
  return `${SEPARATOR_LINE}\n${LABELS.separator}\n${report.id}\n${SEPARATOR_LINE}`
}

// In the server's time zone (BUG_REPORT_TIMEZONE overrides it), with the zone
// named, so the time reads at a glance.
function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString("ru-RU", { timeZone: process.env.BUG_REPORT_TIMEZONE || undefined, timeZoneName: "short" })
  } catch {
    return iso
  }
}

// Plain text (no parse mode), so nothing a person typed can turn into markup.
export function formatBugReport(report: BugReportForDelivery): string {
  const who = report.reporter.displayName || report.reporter.username || report.reporter.id
  const head = [
    `${LABELS.title} ${report.id}`,
    `${LABELS.from}: ${who}${report.reporter.username ? " (@" + report.reporter.username + ")" : ""}`,
    `${LABELS.at}: ${localTime(report.createdAt)}`,
  ]
  const d = report.diagnostics
  const details: string[] = []
  if (d) {
    if (d.version) details.push(`${LABELS.version}: ${d.version}${d.build ? ` (${LABELS.build} ${d.build})` : ""}`)
    for (const key of ["platform", "userAgent", "language", "screen", "viewport", "timezone", "online", "page"] as const) {
      if (d[key]) details.push(`${LABELS[key]}: ${d[key]}`)
    }
    if (d.errors?.length) details.push(`${LABELS.errors}:`, ...d.errors.map((line) => "- " + line))
  }
  const headText = head.join("\n")
  const tailText = details.length ? `\n\n— ${LABELS.details} —\n` + details.join("\n") : ""
  // The person's text gives way first if everything does not fit.
  const room = Math.max(200, TELEGRAM_TEXT_MAX - headText.length - tailText.length - 2)
  const body = report.text.length > room ? report.text.slice(0, room - 1) + "…" : report.text
  return (headText + "\n\n" + body + tailText).slice(0, TELEGRAM_TEXT_MAX)
}

type FetchLike = typeof fetch
const REQUEST_TIMEOUT_MS = 20000

async function callTelegram(target: TelegramTarget, method: string, body: FormData | Record<string, unknown>, fetchImpl: FetchLike): Promise<{ message_id: number }> {
  return (await callTelegramRaw(target, method, body, fetchImpl)) as { message_id: number }
}

async function callTelegramRaw(target: TelegramTarget, method: string, body: FormData | Record<string, unknown>, fetchImpl: FetchLike): Promise<unknown> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData
  const res = await fetchImpl(`${target.apiBase}/bot${target.token}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null
  if (!res.ok || !data?.ok || !data.result) throw new Error(`telegram ${method}: ${data?.description ?? "HTTP " + res.status}`)
  return data.result
}

// Sends a separator (silently: the notification should show the report
// itself), the report, then the screenshots as a reply to it: one as a
// photo, several as an album. Pictures Telegram will not take as photos go as
// files. The result says whether the text went out (retrying would then only
// send it twice) and why the pictures did not, if they did not.
export async function deliverBugReport(target: TelegramTarget, report: BugReportForDelivery, fetchImpl: FetchLike = fetch): Promise<{ screenshotError: string | null }> {
  await callTelegram(target, "sendMessage", { chat_id: target.chatId, text: formatSeparator(report), disable_notification: true }, fetchImpl)
  const sent = await callTelegram(target, "sendMessage", { chat_id: target.chatId, text: formatBugReport(report), link_preview_options: { is_disabled: true } }, fetchImpl)
  const shots = report.screenshots
  if (shots.length === 0) return { screenshotError: null }
  const reply = JSON.stringify({ message_id: sent.message_id })
  const blob = (shot: Screenshot) => new Blob([new Uint8Array(shot.bytes)], { type: shot.type })
  const name = (shot: Screenshot, index: number) => `${report.id}-${index + 1}.${SCREENSHOT_TYPES[shot.type] ?? "png"}`
  let lastError: string | null = null
  for (const kind of ["photo", "document"] as const) {
    const form = new FormData()
    form.set("chat_id", target.chatId)
    form.set("reply_parameters", reply)
    let method: string
    if (shots.length === 1) {
      method = kind === "photo" ? "sendPhoto" : "sendDocument"
      form.set("caption", LABELS.screenshot)
      form.set(kind, blob(shots[0]), name(shots[0], 0))
    } else {
      method = "sendMediaGroup"
      const caption = `${LABELS.screenshots} (${shots.length})`
      form.set("media", JSON.stringify(shots.map((_shot, index) => ({ type: kind, media: `attach://shot${index}`, ...(index === 0 ? { caption } : {}) }))))
      shots.forEach((shot, index) => form.set(`shot${index}`, blob(shot), name(shot, index)))
    }
    try {
      await callTelegramRaw(target, method, form, fetchImpl)
      return { screenshotError: null }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  return { screenshotError: lastError }
}

// Minutes to wait before the next attempt: 1, 2, 4 ... up to an hour.
export function retryDelayMinutes(attempts: number): number {
  return Math.min(BUG_REPORT_MAX_RETRY_MINUTES, 2 ** Math.max(0, attempts - 1))
}
