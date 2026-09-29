import { accountKey, adoptLegacyPreference } from "./session"

// Messages typed while the network is down. They are kept on the device (plain
// text, the same place the draft already lives) and sent in order as soon as
// the connection is back, so a tap on "send" is never silently lost.

const OUTBOX_KEY = "frontierx.outbox"

function outboxKey(): string {
	adoptLegacyPreference(OUTBOX_KEY)
	return accountKey(OUTBOX_KEY)
}
const MAX_ITEMS = 200

export interface OutboxItem {
	id: string
	conversationId: string
	body: string
	replyTo: string | null
	createdAt: string
	silent?: boolean
}

export function loadOutbox(): OutboxItem[] {
	try {
		const raw = window.localStorage.getItem(outboxKey())
		if (!raw) return []
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter((item): item is OutboxItem =>
			Boolean(item) &&
			typeof (item as OutboxItem).id === "string" &&
			typeof (item as OutboxItem).conversationId === "string" &&
			typeof (item as OutboxItem).body === "string",
		)
	} catch {
		return []
	}
}

export function saveOutbox(items: OutboxItem[]): void {
	try {
		window.localStorage.setItem(outboxKey(), JSON.stringify(items.slice(-MAX_ITEMS)))
	} catch {
		// Storage can be full or blocked; the queue then lives for this session.
	}
}

export function newOutboxItem(conversationId: string, body: string, replyTo: string | null, silent = false): OutboxItem {
	return {
		id: "out-" + String(Date.now()) + "-" + String(Math.round(Math.random() * 1e6)),
		conversationId,
		body,
		replyTo,
		createdAt: new Date().toISOString(),
		silent,
	}
}

// Whether a failed send looks like "no network" rather than a refusal from the
// server - the first is worth queueing, the second is not.
export function isOfflineFailure(error: unknown): boolean {
	if (typeof navigator !== "undefined" && navigator.onLine === false) return true
	if (error instanceof TypeError) return true
	const status = (error as { status?: number } | null)?.status
	if (typeof status === "number") return status === 0 || status === 502 || status === 503 || status === 504
	return false
}
