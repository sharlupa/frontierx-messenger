import type { MessageEnvelope } from "./types"

// What the app shows without a network: the last answers of the server for
// the chat list, keys, members and so on, the messages of every chat opened
// on this device, and the encrypted files it downloaded or sent.
//
// Everything here is what the server holds anyway: message bodies and files
// stay sealed, and are opened only with keys this device already keeps. One
// account's copy is wiped when the account is removed from the device.

const DB_NAME = "frontierx-offline"
const DB_VERSION = 1
const RESPONSES = "responses"
const MESSAGES = "messages"
const BLOB_INDEX = "blobIndex"
const BLOBS = "blobs"

// The newest messages of a chat that are kept; older ones are read online.
export const MAX_MESSAGES_PER_CHAT = 3000
// Files: the ones opened longest ago go first once the total is over the cap.
const BLOB_CAP_BYTES = 1024 * 1024 * 1024
const BLOB_MAX_FILE_BYTES = 300 * 1024 * 1024

type ResponseRecord = { key: string; account: string; data: unknown; savedAt: number }
type MessagesRecord = { key: string; account: string; conversationId: string; messages: MessageEnvelope[] }
type BlobIndexRecord = { key: string; account: string; size: number; usedAt: number }
type BlobRecord = { key: string; data: Blob }

// --- connection state -----------------------------------------------------------

let offline = typeof navigator !== "undefined" && navigator.onLine === false
const listeners = new Set<(offline: boolean) => void>()

function setOffline(next: boolean): void {
	if (offline === next) return
	offline = next
	for (const listener of Array.from(listeners)) {
		try {
			listener(next)
		} catch {
			// one listener's failure must not stop the others
		}
	}
}

// A request that never reached the server, or one the server answered.
export function noteNetworkFailure(): void {
	setOffline(true)
}

export function noteNetworkSuccess(): void {
	setOffline(false)
}

export function isOffline(): boolean {
	return offline
}

export function onOfflineChange(listener: (offline: boolean) => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("offline", () => setOffline(true))
	// "online" only says a network is there; the next answer from the server
	// confirms it, so the banner does not vanish on a network without internet.
}

// The browser knows for sure there is no network: no point in waiting.
export function deviceOffline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false
}

// --- storage ------------------------------------------------------------------------

let databasePromise: Promise<IDBDatabase | null> | null = null

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
	})
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve()
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
	})
}

// Null where there is no IndexedDB (tests, a blocked private window): the app
// then simply works online only.
function openDatabase(): Promise<IDBDatabase | null> {
	if (databasePromise) return databasePromise
	databasePromise = new Promise((resolve) => {
		if (typeof indexedDB === "undefined") {
			resolve(null)
			return
		}
		let request: IDBOpenDBRequest
		try {
			request = indexedDB.open(DB_NAME, DB_VERSION)
		} catch {
			resolve(null)
			return
		}
		request.onupgradeneeded = () => {
			const database = request.result
			for (const name of [RESPONSES, MESSAGES, BLOB_INDEX]) {
				if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: "key" }).createIndex("account", "account")
			}
			if (!database.objectStoreNames.contains(BLOBS)) database.createObjectStore(BLOBS, { keyPath: "key" })
		}
		request.onsuccess = () => {
			const database = request.result
			// Another tab with a newer build upgrades the database: step aside.
			database.onversionchange = () => {
				database.close()
				databasePromise = null
			}
			resolve(database)
		}
		request.onerror = () => resolve(null)
		request.onblocked = () => resolve(null)
	})
	return databasePromise
}

function recordKey(account: string, id: string): string {
	return account + " " + id
}

// --- server answers -----------------------------------------------------------------

export async function saveResponse(account: string, path: string, data: unknown): Promise<void> {
	const database = await openDatabase()
	if (!database) return
	try {
		const transaction = database.transaction(RESPONSES, "readwrite")
		const record: ResponseRecord = { key: recordKey(account, path), account, data, savedAt: Date.now() }
		transaction.objectStore(RESPONSES).put(record)
		await transactionDone(transaction)
	} catch {
		// storage full or gone: this answer is simply not kept
	}
}

export async function loadResponse<T>(account: string, path: string): Promise<T | undefined> {
	const database = await openDatabase()
	if (!database) return undefined
	try {
		const transaction = database.transaction(RESPONSES, "readonly")
		const record = await requestValue(transaction.objectStore(RESPONSES).get(recordKey(account, path)) as IDBRequest<ResponseRecord | undefined>)
		return record ? (record.data as T) : undefined
	} catch {
		return undefined
	}
}

// --- messages -----------------------------------------------------------------------

// Messages are ordered like the server orders them: by time, then by id.
type Position = { createdAt: string; id: string }

function compare(a: Position, b: Position): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
	if (a.id === b.id) return 0
	return a.id < b.id ? -1 : 1
}

// The stretch of a chat a server answer covers completely: whatever the
// device kept inside it and the answer no longer has is gone on the server
// (deleted, expired). Null ends are open.
export type MessageRange = {
	from: Position | null
	fromInclusive: boolean
	to: Position | null
	toInclusive: boolean
}

function inRange(message: Position, range: MessageRange): boolean {
	if (range.from) {
		const c = compare(message, range.from)
		if (c < 0 || (c === 0 && !range.fromInclusive)) return false
	}
	if (range.to) {
		const c = compare(message, range.to)
		if (c > 0 || (c === 0 && !range.toInclusive)) return false
	}
	return true
}

export function mergeMessages(stored: MessageEnvelope[], incoming: MessageEnvelope[], range: MessageRange, cap = MAX_MESSAGES_PER_CHAT): MessageEnvelope[] {
	const byId = new Map<string, MessageEnvelope>()
	for (const message of stored) if (!inRange(message, range)) byId.set(message.id, message)
	for (const message of incoming) byId.set(message.id, message)
	const merged = Array.from(byId.values()).sort(compare)
	return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

export type MessagePage = { messages: MessageEnvelope[]; hasMore: boolean; hasNewer: boolean }

// A page in the shape the server answers it, from what the device kept.
export function pageFromStore(stored: MessageEnvelope[], query: { limit: number; before?: string | null; around?: string | null; after?: string | null }): MessagePage | null {
	const limit = Math.max(1, query.limit)
	if (query.around) {
		const at = stored.findIndex((message) => message.id === query.around)
		if (at < 0) return null
		const half = Math.max(1, Math.floor(limit / 2))
		const start = Math.max(0, at - half)
		const end = Math.min(stored.length, at + half)
		return { messages: stored.slice(start, end), hasMore: start > 0, hasNewer: end < stored.length }
	}
	if (query.after) {
		const at = stored.findIndex((message) => message.id === query.after)
		if (at < 0) return null
		const messages = stored.slice(at + 1, at + 1 + limit)
		return { messages, hasMore: true, hasNewer: at + 1 + limit < stored.length }
	}
	let end = stored.length
	if (query.before) {
		end = stored.findIndex((message) => message.id === query.before)
		if (end < 0) return null
	}
	const start = Math.max(0, end - limit)
	return { messages: stored.slice(start, end), hasMore: start > 0, hasNewer: false }
}

// What a server answer to a page request covers (see MessageRange).
export function rangeOfPage(page: MessagePage, query: { before?: string | null; around?: string | null; after?: string | null }, cursor: Position | null): MessageRange | null {
	const first = page.messages[0] ?? null
	const last = page.messages[page.messages.length - 1] ?? null
	if (query.around) {
		if (!first || !last) return null
		return { from: page.hasMore ? first : null, fromInclusive: true, to: page.hasNewer ? last : null, toInclusive: true }
	}
	if (query.after) {
		if (!cursor) return null
		return { from: cursor, fromInclusive: false, to: page.hasNewer ? last : null, toInclusive: true }
	}
	if (query.before) {
		// Without the cursor in hand, only the stretch the page itself spans.
		if (!cursor) return first && last ? { from: first, fromInclusive: true, to: last, toInclusive: true } : null
		return { from: page.hasMore ? first : null, fromInclusive: true, to: cursor, toInclusive: false }
	}
	return { from: page.hasMore ? first : null, fromInclusive: true, to: null, toInclusive: true }
}

async function readMessages(database: IDBDatabase, key: string): Promise<MessageEnvelope[]> {
	return (await readMessagesOrNull(database, key)) ?? []
}

// null: the chat was never saved on this device (not the same as empty).
async function readMessagesOrNull(database: IDBDatabase, key: string): Promise<MessageEnvelope[] | null> {
	const transaction = database.transaction(MESSAGES, "readonly")
	const record = await requestValue(transaction.objectStore(MESSAGES).get(key) as IDBRequest<MessagesRecord | undefined>)
	return record ? record.messages : null
}

// Writes of one chat run one after another, so two answers arriving together
// never overwrite each other's messages.
const messageQueue = new Map<string, Promise<void>>()

function queued(key: string, run: () => Promise<void>): Promise<void> {
	const previous = messageQueue.get(key) ?? Promise.resolve()
	const next = previous.then(run, run).catch(() => undefined)
	messageQueue.set(key, next)
	void next.then(() => {
		if (messageQueue.get(key) === next) messageQueue.delete(key)
	})
	return next
}

export async function loadMessages(account: string, conversationId: string): Promise<MessageEnvelope[]> {
	return (await loadSavedMessages(account, conversationId)) ?? []
}

// Like loadMessages, with null for a chat this device never saved.
export function loadSavedMessages(account: string, conversationId: string): Promise<MessageEnvelope[] | null> {
	const key = recordKey(account, conversationId)
	// Waits for writes in flight, so a page read right after one sees it.
	return (messageQueue.get(key) ?? Promise.resolve()).then(async () => {
		const database = await openDatabase()
		if (!database) return null
		try {
			return await readMessagesOrNull(database, key)
		} catch {
			return null
		}
	})
}

export function storeMessages(account: string, conversationId: string, incoming: MessageEnvelope[], range: MessageRange): Promise<void> {
	const key = recordKey(account, conversationId)
	return queued(key, async () => {
		const database = await openDatabase()
		if (!database) return
		const own = incoming.filter((message) => message.conversationId === conversationId)
		const stored = await readMessages(database, key)
		const messages = mergeMessages(stored, own, range)
		const transaction = database.transaction(MESSAGES, "readwrite")
		const record: MessagesRecord = { key, account, conversationId, messages }
		transaction.objectStore(MESSAGES).put(record)
		await transactionDone(transaction)
	})
}

// The chat as the app holds it right now (messages that came in live,
// edits, deletions): from its oldest loaded message on, or only the window
// it shows when that is not the latest stretch.
export function storeOpenChat(account: string, conversationId: string, messages: MessageEnvelope[], hasMore: boolean, hasNewer: boolean): Promise<void> {
	const own = messages.filter((message) => message.conversationId === conversationId)
	if (own.length === 0) return Promise.resolve()
	const range: MessageRange = {
		from: hasMore ? own[0] : null,
		fromInclusive: true,
		to: hasNewer ? own[own.length - 1] : null,
		toInclusive: true,
	}
	return storeMessages(account, conversationId, own, range)
}

// --- encrypted files ---------------------------------------------------------------

export async function loadBlob(account: string, fileId: string): Promise<Uint8Array | null> {
	const database = await openDatabase()
	if (!database) return null
	const key = recordKey(account, fileId)
	try {
		const transaction = database.transaction([BLOBS, BLOB_INDEX], "readwrite")
		const record = await requestValue(transaction.objectStore(BLOBS).get(key) as IDBRequest<BlobRecord | undefined>)
		if (!record) return null
		const index = transaction.objectStore(BLOB_INDEX)
		const meta = await requestValue(index.get(key) as IDBRequest<BlobIndexRecord | undefined>)
		if (meta) index.put({ ...meta, usedAt: Date.now() })
		await transactionDone(transaction)
		return new Uint8Array(await record.data.arrayBuffer())
	} catch {
		return null
	}
}

let trimTimer: ReturnType<typeof setTimeout> | null = null

export async function saveBlob(account: string, fileId: string, data: Uint8Array | Blob): Promise<void> {
	const size = data instanceof Blob ? data.size : data.byteLength
	if (size <= 0 || size > BLOB_MAX_FILE_BYTES) return
	const database = await openDatabase()
	if (!database) return
	const key = recordKey(account, fileId)
	try {
		const blob = data instanceof Blob ? data : new Blob([data as BlobPart])
		const transaction = database.transaction([BLOBS, BLOB_INDEX], "readwrite")
		const record: BlobRecord = { key, data: blob }
		const meta: BlobIndexRecord = { key, account, size, usedAt: Date.now() }
		transaction.objectStore(BLOBS).put(record)
		transaction.objectStore(BLOB_INDEX).put(meta)
		await transactionDone(transaction)
	} catch {
		// no room: the file stays online only
		return
	}
	if (!trimTimer) {
		trimTimer = setTimeout(() => {
			trimTimer = null
			void trimBlobs()
		}, 2000)
		const handle = trimTimer as unknown as { unref?: () => void }
		if (typeof handle.unref === "function") handle.unref()
	}
}

async function blobCap(): Promise<number> {
	try {
		const estimate = await navigator.storage?.estimate?.()
		if (estimate && typeof estimate.quota === "number" && estimate.quota > 0) return Math.min(BLOB_CAP_BYTES, Math.floor(estimate.quota * 0.3))
	} catch {
		// unknown quota: the fixed cap
	}
	return BLOB_CAP_BYTES
}

async function trimBlobs(): Promise<void> {
	const database = await openDatabase()
	if (!database) return
	try {
		const cap = await blobCap()
		const read = database.transaction(BLOB_INDEX, "readonly")
		const all = await requestValue(read.objectStore(BLOB_INDEX).getAll() as IDBRequest<BlobIndexRecord[]>)
		let total = all.reduce((sum, item) => sum + item.size, 0)
		if (total <= cap) return
		all.sort((a, b) => a.usedAt - b.usedAt)
		const doomed: string[] = []
		for (const item of all) {
			if (total <= cap) break
			doomed.push(item.key)
			total -= item.size
		}
		const write = database.transaction([BLOBS, BLOB_INDEX], "readwrite")
		for (const key of doomed) {
			write.objectStore(BLOBS).delete(key)
			write.objectStore(BLOB_INDEX).delete(key)
		}
		await transactionDone(write)
	} catch {
		// tried again after the next save
	}
}

// --- removal ----------------------------------------------------------------------

export async function forgetAccount(account: string): Promise<void> {
	const database = await openDatabase()
	if (!database) return
	try {
		const transaction = database.transaction([RESPONSES, MESSAGES, BLOB_INDEX, BLOBS], "readwrite")
		for (const name of [RESPONSES, MESSAGES, BLOB_INDEX]) {
			const keys = await requestValue(transaction.objectStore(name).index("account").getAllKeys(IDBKeyRange.only(account)))
			for (const key of keys) {
				transaction.objectStore(name).delete(key)
				if (name === BLOB_INDEX) transaction.objectStore(BLOBS).delete(key)
			}
		}
		await transactionDone(transaction)
	} catch {
		// the next removal tries again
	}
}

export async function forgetConversation(account: string, conversationId: string): Promise<void> {
	const database = await openDatabase()
	if (!database) return
	try {
		const transaction = database.transaction(MESSAGES, "readwrite")
		transaction.objectStore(MESSAGES).delete(recordKey(account, conversationId))
		await transactionDone(transaction)
	} catch {
		// left for the next time
	}
}
