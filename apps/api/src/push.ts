import { assertPublicUrl, guardedRequest } from "./netguard.js"
import { FcmSender } from "./fcm.js"
import type { WebPushSender, WebPushSubscription } from "./webpush.js"

// Push delivery for mobile clients over UnifiedPush.
//
// The Android client registers with a distributor (ntfy or any other UnifiedPush
// provider) and reports the resulting endpoint URL here. Delivery is a plain
// HTTP POST of a small JSON payload to that endpoint, so there is no vendor SDK,
// no Google services and no API key on the server.
//
// Delivery is best effort and always detached from the request that triggered
// it: a slow or dead distributor must never delay an API response or the
// WebSocket fan-out that serves connected clients.

const PUSH_TIMEOUT_MS = 10000
const TITLE_LIMIT = 120
const BODY_LIMIT = 400

export type PushKind = "message" | "call" | "test"

export interface PushPayload {
  type: PushKind
  title: string
  body: string
  conversationId?: string | null
  messageId?: string | null
}

// Web push notifications name the account they belong to, so a browser with
// several signed-in accounts opens the right one.
export interface WebPushInfo {
  accountName?: (userId: string) => string | null
}

export interface PushEndpointRecord {
  id: string
  userId: string
  endpoint: string
}

// Only the methods push delivery needs, so the sender stays testable and does
// not depend on the whole Store surface. Web push subscriptions are optional.
export interface PushStore {
  listPushEndpoints(userId: string): PushEndpointRecord[]
  deletePushEndpointByUrl(endpoint: string): void
  listWebPushSubscriptions?(userId: string): WebPushSubscription[]
  deleteWebPushSubscription?(endpoint: string, userId?: string): void
}

function clamp(value: string, limit: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

// An endpoint is a URL the server will POST to on its own, so it gets the same
// treatment as any user-supplied outbound address: HTTPS only, and never this
// machine or a private network (loopback hosts admin APIs).
export function isAcceptableEndpoint(endpoint: string): boolean {
  if (endpoint.length > 500) return false
  try {
    assertPublicUrl(endpoint, { httpsOnly: true })
    return true
  } catch {
    return false
  }
}

// A distributor answers 404 or 410 once a registration is gone for good; those
// endpoints are dropped so the table does not grow with dead rows.
function endpointIsGone(status: number): boolean {
  return status === 404 || status === 410
}

export async function postPush(endpoint: string, payload: PushPayload): Promise<number> {
  const body = JSON.stringify({
    type: payload.type,
    title: clamp(payload.title, TITLE_LIMIT),
    body: clamp(payload.body, BODY_LIMIT),
    conversationId: payload.conversationId ?? null,
    messageId: payload.messageId ?? null,
    sentAt: new Date().toISOString(),
  })
  // Redirects are not followed: a distributor has no reason to send one, and
  // following it would let an endpoint bounce the request somewhere internal.
  const response = await guardedRequest(assertPublicUrl(endpoint, { httpsOnly: true }), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Keep a queued notification for a day and let the distributor wake the
      // device: the payload is what the user sees when the app is not running.
      ttl: "86400",
      urgency: "high",
    },
    body,
    timeoutMs: PUSH_TIMEOUT_MS,
    maxBytes: 64 * 1024,
  })
  return response.status
}

// Android devices with Google services register an FCM token instead of a
// UnifiedPush URL; it is stored in the same table with this prefix.
export const FCM_PREFIX = "fcm:"

export class PushSender {
  constructor(
    private readonly store: PushStore,
    private readonly isUserOnline: (userId: string) => boolean,
    readonly fcm: FcmSender = new FcmSender(),
    readonly webpush: WebPushSender | null = null,
    private readonly info: WebPushInfo = {},
  ) {}

  // Fire and forget. Callers stay synchronous.
  notifyUsers(
    userIds: Iterable<string>,
    payload: PushPayload,
    options: { exclude?: Iterable<string>; force?: boolean } = {},
  ): void {
    const excluded = new Set(options.exclude ?? [])
    const targets: string[] = []
    for (const userId of userIds) {
      if (!userId || excluded.has(userId)) continue
      if (!options.force && this.isUserOnline(userId)) continue
      targets.push(userId)
    }
    if (targets.length === 0) return
    void this.deliver(targets, payload)
  }

  async deliverToUser(userId: string, payload: PushPayload): Promise<number> {
    return this.deliver([userId], payload)
  }

  private async deliver(userIds: string[], payload: PushPayload): Promise<number> {
    let delivered = 0
    const seen = new Set<string>()
    for (const userId of userIds) {
      if (seen.has(userId)) continue
      seen.add(userId)
      let endpoints: PushEndpointRecord[]
      try {
        endpoints = this.store.listPushEndpoints(userId)
      } catch {
        continue
      }
      delivered += await this.deliverWebPush(userId, payload)
      for (const record of endpoints) {
        try {
          if (record.endpoint.startsWith(FCM_PREFIX)) {
            // Google only learns that something happened in some chat: no names,
            // no text. The phone looks the chat title up from this server itself.
            const result = await this.fcm.send(record.endpoint.slice(FCM_PREFIX.length), {
              type: payload.type,
              conversationId: payload.conversationId ?? "",
            }, payload.type === "call" ? 60 : 86400)
            if (result === "gone") this.store.deletePushEndpointByUrl(record.endpoint)
            else if (result === "sent") delivered += 1
            continue
          }
          const status = await postPush(record.endpoint, payload)
          if (endpointIsGone(status)) {
            this.store.deletePushEndpointByUrl(record.endpoint)
            continue
          }
          if (status < 400) delivered += 1
        } catch {
          // Network failures are transient; the next event retries naturally.
        }
      }
    }
    return delivered
  }

  private async deliverWebPush(userId: string, payload: PushPayload): Promise<number> {
    if (!this.webpush || !this.store.listWebPushSubscriptions) return 0
    let subscriptions: WebPushSubscription[]
    try {
      subscriptions = this.store.listWebPushSubscriptions(userId)
    } catch {
      return 0
    }
    let delivered = 0
    for (const subscription of subscriptions) {
      const result = await this.webpush.send(
        subscription,
        {
          type: payload.type,
          title: clamp(payload.title, TITLE_LIMIT),
          body: clamp(payload.body, BODY_LIMIT),
          conversationId: payload.conversationId ?? null,
          accountId: userId,
          accountName: this.info.accountName ? this.info.accountName(userId) : null,
          sentAt: new Date().toISOString(),
        },
        { urgency: payload.type === "call" ? "high" : "normal", ttl: payload.type === "call" ? 60 : 86400, topic: payload.conversationId ? userId + ":" + payload.conversationId : undefined },
      )
      if (result === "gone" && this.store.deleteWebPushSubscription) this.store.deleteWebPushSubscription(subscription.endpoint, userId)
      else if (result === "sent") delivered += 1
    }
    return delivered
  }
}