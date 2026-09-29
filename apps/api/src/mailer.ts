import { existsSync } from "node:fs"

// Transactional email for account recovery and for verifying an address the
// user attaches to an account.
//
// Email is optional in FrontierX: an account works without it. If RESEND_API_KEY
// is not configured the mailer stays disabled and callers report a clear error
// instead of pretending that a code was delivered.

const DEFAULT_FROM = "FrontierX <no-reply@frontierx.zkito.fun>"
const SEND_TIMEOUT_MS = 15000

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  readonly enabled: boolean
  send(message: MailMessage): Promise<void>
}

export class MailerDisabledError extends Error {
  constructor() {
    super("email delivery is not configured")
    this.name = "MailerDisabledError"
  }
}

class ResendMailer implements Mailer {
  readonly enabled = true

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`resend responded ${response.status}: ${detail.slice(0, 300)}`)
    }
  }
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return "=?UTF-8?B?" + Buffer.from(value, "utf8").toString("base64") + "?="
}

function envelopeAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from)
  return (match ? match[1] : from).trim()
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// A bare one-line plain text message is a strong spam signal, so every message
// carries a matching HTML part as well.
function htmlFromText(text: string): string {
  const body = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => "<p style=\"margin:0 0 12px;font-size:15px;line-height:22px;color:#111111\">" + escapeHtml(line) + "</p>")
    .join("\n")
  return [
    "<!doctype html>",
    "<html><body style=\"margin:0;padding:24px;background:#f5f6f8\">",
    "<div style=\"max-width:520px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif\">",
    "<div style=\"font-weight:600;font-size:16px;color:#111111;margin:0 0 16px\">FrontierX</div>",
    body,
    "</div></body></html>",
  ].join("\n")
}

function base64Body(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64")
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n")
}

// Local delivery through the system MTA (postfix on the API host). Recovery and
// verification codes work without any third-party API key.
class SendmailMailer implements Mailer {
  readonly enabled = true

  constructor(
    private readonly binary: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const { spawn } = await import("node:child_process")
    const sender = envelopeAddress(this.from)
    const domain = sender.includes("@") ? sender.slice(sender.indexOf("@") + 1) : "localhost"
    const boundary = "fx" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    const headers = [
      "From: " + this.from,
      "To: " + message.to,
      "Reply-To: " + sender,
      "Subject: " + encodeHeader(message.subject),
      "Date: " + new Date().toUTCString(),
      "Message-ID: <" + Date.now().toString(36) + "." + Math.random().toString(36).slice(2, 12) + "@" + domain + ">",
      "Auto-Submitted: auto-generated",
      "MIME-Version: 1.0",
      "Content-Type: multipart/alternative; boundary=\"" + boundary + "\"",
    ]
    const parts = [
      "--" + boundary,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(message.text.replace(/\r?\n/g, "\r\n")),
      "--" + boundary,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(htmlFromText(message.text)),
      "--" + boundary + "--",
      "",
    ]
    const payload = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n")
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.binary, ["-i", "-f", sender, "-t"], { stdio: ["pipe", "ignore", "pipe"] })
      let stderr = ""
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error("sendmail timed out"))
      }, SEND_TIMEOUT_MS)
      child.stderr?.on("data", (chunk: unknown) => {
        stderr += String(chunk)
      })
      child.on("error", (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on("close", (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error("sendmail exited with " + String(code) + ": " + stderr.slice(0, 300)))
      })
      child.stdin?.end(Buffer.from(payload, "utf8"))
    })
  }
}

function findSendmail(): string | null {
  for (const candidate of ["/usr/sbin/sendmail", "/usr/lib/sendmail", "/usr/bin/sendmail"]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

// Delivery has two routes. The relay is tried first because large providers
// accept it, and the local queue takes over when the relay refuses a message,
// for example while the sending domain is still unverified.
class FallbackMailer implements Mailer {
  readonly enabled = true

  constructor(
    private readonly primary: Mailer,
    private readonly secondary: Mailer,
  ) {}

  async send(message: MailMessage): Promise<void> {
    try {
      await this.primary.send(message)
    } catch (err) {
      console.error("[mail] relay refused the message, using the local queue", err)
      await this.secondary.send(message)
    }
  }
}

class DisabledMailer implements Mailer {
  readonly enabled = false

  async send(): Promise<void> {
    throw new MailerDisabledError()
  }
}

export function createMailer(env: Record<string, string | undefined> = process.env): Mailer {
  const from = (env.MAIL_FROM ?? "").trim() || DEFAULT_FROM
  const apiKey = (env.RESEND_API_KEY ?? "").trim()
  const transport = (env.MAIL_TRANSPORT ?? "").trim().toLowerCase()
  if (transport === "none") return new DisabledMailer()
  const binary = (env.SENDMAIL_PATH ?? "").trim() || findSendmail()
  const local = binary ? new SendmailMailer(binary, from) : null
  const relay = apiKey ? new ResendMailer(apiKey, from) : null
  if (transport === "sendmail") return local ?? relay ?? new DisabledMailer()
  if (relay && local) return new FallbackMailer(relay, local)
  return relay ?? local ?? new DisabledMailer()
}

// Addresses are stored and compared in a single normalized form so that a
// recovery request cannot be aimed at a different account by changing case.
export function normalizeEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  if (email.length < 6 || email.length > 254) return false
  if (/\s/.test(email)) return false
  const parts = email.split("@")
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || local.length > 64) return false
  if (!domain || domain.length > 189 || !domain.includes(".")) return false
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && /^[a-z0-9.-]+$/.test(domain)
}

export function verificationEmail(code: string, ttlMinutes: number): { subject: string; text: string } {
  return {
    subject: "FrontierX: подтверждение адреса",
    text: [
      `Код подтверждения: ${code}`,
      "",
      `Код действует ${ttlMinutes} минут и нужен один раз.`,
      "Если вы не привязывали этот адрес к FrontierX, просто удалите письмо.",
    ].join("\n"),
  }
}

export function passwordResetEmail(code: string, ttlMinutes: number): { subject: string; text: string } {
  return {
    subject: "FrontierX: восстановление пароля",
    text: [
      `Код для сброса пароля: ${code}`,
      "",
      `Код действует ${ttlMinutes} минут. Введите его в приложении вместе с новым паролем.`,
      "Если вы не запрашивали восстановление, пароль менять не нужно: без кода доступ не изменится.",
    ].join("\n"),
  }
}