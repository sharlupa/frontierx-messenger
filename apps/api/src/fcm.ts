// Firebase Cloud Messaging (HTTP v1) sender for Android devices with Google
// services. The phone's system push channel wakes the app, so the app needs no
// permanent background connection and no "running in background" notification.
//
// Only a tiny data message goes through Google: the kind of event and the chat
// id. Message text is end-to-end encrypted and never leaves the server in any
// readable form anyway.
//
// Configuration: FCM_SERVICE_ACCOUNT_FILE points to the service-account JSON
// downloaded from the Firebase console. Without it FCM stays disabled and
// Android falls back to its own socket channel.

import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

export type FcmResult = "sent" | "gone" | "failed"

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
const TIMEOUT_MS = 10000

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

export class FcmSender {
  private account: ServiceAccount | null = null
  private accessToken: { value: string; expiresAt: number } | null = null

  constructor(file = process.env.FCM_SERVICE_ACCOUNT_FILE) {
    if (!file) return
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ServiceAccount
      if (parsed.project_id && parsed.client_email && parsed.private_key) this.account = parsed
      else console.error("[fcm] service account file is missing fields")
    } catch (error) {
      console.error("[fcm] cannot read service account file", (error as Error).message)
    }
  }

  get enabled(): boolean {
    return this.account !== null
  }

  // OAuth2 access token from a self-signed JWT (RFC 7523), cached until shortly
  // before it expires.
  private async token(): Promise<string> {
    const account = this.account
    if (!account) throw new Error("fcm disabled")
    const now = Math.floor(Date.now() / 1000)
    if (this.accessToken && this.accessToken.expiresAt - 120 > now) return this.accessToken.value
    const tokenUri = account.token_uri || DEFAULT_TOKEN_URI
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }))
    const signer = createSign("RSA-SHA256")
    signer.update(header + "." + claims)
    const assertion = header + "." + claims + "." + base64url(signer.sign(account.private_key))
    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error("fcm token request failed: " + response.status)
    const data = (await response.json()) as { access_token: string; expires_in: number }
    this.accessToken = { value: data.access_token, expiresAt: now + Number(data.expires_in || 3600) }
    return data.access_token
  }

  // Sends a high-priority data message; the app builds the notification itself.
  async send(deviceToken: string, data: Record<string, string>, ttlSeconds = 86400): Promise<FcmResult> {
    const account = this.account
    if (!account) return "failed"
    const accessToken = await this.token()
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + accessToken },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          data,
          android: { priority: "HIGH", ttl: ttlSeconds + "s" },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.ok) return "sent"
    // 404 UNREGISTERED / 400 INVALID_ARGUMENT on the token: the app was removed
    // or the token rotated, so the row is dropped.
    if (response.status === 404) return "gone"
    if (response.status === 400) {
      const text = await response.text().catch(() => "")
      if (text.includes("registration token") || text.includes("UNREGISTERED")) return "gone"
    }
    if (response.status === 401) this.accessToken = null
    return "failed"
  }
}
