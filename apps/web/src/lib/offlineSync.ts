import { api } from "./api"
import { getActiveAccountId } from "./session"
import { isOffline, loadSavedMessages, storeMessages } from "./offline"
import type { MessageEnvelope } from "./types"

// Every chat is kept on the device, not only the ones opened here, so any of
// them reads without a network. In the background, one chat at a time, the
// newest message of each chat is compared with the device's copy; only a chat
// with something new loads its latest page, and its keys and members, which a
// new message may need. Messages stay sealed as the server sends them, and
// photos and videos are not fetched ahead: a chat costs about its text.

const LATEST_PAGE = 50
// More than a page came in while away: this much is walked back to reach
// what the device has, otherwise the copy starts afresh from the latest.
const CATCH_UP_PAGE = 100
const CATCH_UP_PAGES = 3
const PAUSE_MS = 150
const SOON_MS = 3000

let queue: string[] = []
let account: string | null = null
let running = false
const soonTimers = new Map<string, ReturnType<typeof setTimeout>>()

// The whole list, after a start or a reconnect.
export function syncChats(forAccount: string, conversationIds: string[]): void {
	account = forAccount
	queue = Array.from(new Set(conversationIds))
	void run()
}

// One chat that just had a message while another was open.
export function syncChatSoon(forAccount: string, conversationId: string): void {
	if (soonTimers.has(conversationId)) return
	soonTimers.set(conversationId, setTimeout(() => {
		soonTimers.delete(conversationId)
		if (account !== forAccount) queue = []
		account = forAccount
		if (!queue.includes(conversationId)) queue.unshift(conversationId)
		void run()
	}, SOON_MS))
}

async function run(): Promise<void> {
	if (running) return
	running = true
	try {
		while (queue.length > 0) {
			const forAccount = account
			if (!forAccount || isOffline() || getActiveAccountId() !== forAccount) break
			const conversationId = queue.shift() as string
			try {
				await syncChat(forAccount, conversationId)
			} catch {
				if (isOffline()) {
					queue.unshift(conversationId)
					break
				}
			}
			await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
		}
	} finally {
		running = false
	}
}

async function syncChat(forAccount: string, conversationId: string): Promise<void> {
	const saved = await loadSavedMessages(forAccount, conversationId)
	// Pages read through the api are kept on the device as they arrive.
	const head = await api.listMessages(conversationId, { limit: 1 })
	if (head.notSaved) return
	const newest = head.messages[head.messages.length - 1]
	if (saved !== null && (newest ? saved.some((message) => message.id === newest.id) : saved.length === 0)) return
	await Promise.all([
		api.conversationKeys(conversationId).catch(() => undefined),
		api.getConversationMembers(conversationId).catch(() => undefined),
	])
	const latest = await api.listMessages(conversationId, { limit: LATEST_PAGE })
	if (!saved || saved.length === 0 || !latest.hasMore) return
	const savedIds = new Set(saved.map((message) => message.id))
	const reaches = (messages: MessageEnvelope[]) => messages.some((message) => savedIds.has(message.id))
	if (reaches(latest.messages)) return
	let collected = latest.messages
	let more: boolean = latest.hasMore
	for (let page = 0; page < CATCH_UP_PAGES && more && collected.length > 0; page++) {
		const older = await api.listMessages(conversationId, { limit: CATCH_UP_PAGE, before: collected[0].id })
		if (reaches(older.messages)) return
		collected = [...older.messages, ...collected]
		more = older.hasMore
	}
	// Too far behind: what the device had would leave a hole, so it goes.
	await storeMessages(forAccount, conversationId, collected, { from: null, fromInclusive: true, to: null, toInclusive: true })
}
