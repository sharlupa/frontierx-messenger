import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeMessages, pageFromStore, rangeOfPage, type MessageRange } from "../src/lib/offline"
import type { MessageEnvelope } from "../src/lib/types"

function msg(n: number, extra: Partial<MessageEnvelope> = {}): MessageEnvelope {
	return {
		id: "m" + String(n).padStart(3, "0"),
		conversationId: "c1",
		senderId: "u1",
		ciphertext: "x" + n,
		createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
		...extra,
	}
}

function ids(list: MessageEnvelope[]): number[] {
	return list.map((message) => Number(message.id.slice(1)))
}

const everything: MessageRange = { from: null, fromInclusive: true, to: null, toInclusive: true }

test("latest page replaces what the device kept from its first message on", () => {
	const stored = [1, 2, 3, 4, 5, 6].map((n) => msg(n))
	// 4 was deleted on the server, 7 is new, 5 was edited.
	const page = { messages: [msg(3), msg(5, { ciphertext: "edited" }), msg(6), msg(7)], hasMore: true, hasNewer: false }
	const range = rangeOfPage(page, {}, null)
	assert.ok(range)
	const merged = mergeMessages(stored, page.messages, range)
	assert.deepEqual(ids(merged), [1, 2, 3, 5, 6, 7])
	assert.equal(merged.find((m) => m.id === "m005")?.ciphertext, "edited")
})

test("a latest page without more history is the whole chat", () => {
	const stored = [1, 2, 3].map((n) => msg(n))
	const page = { messages: [msg(2), msg(3)], hasMore: false, hasNewer: false }
	assert.deepEqual(ids(mergeMessages(stored, page.messages, rangeOfPage(page, {}, null) as MessageRange)), [2, 3])
	const empty = { messages: [], hasMore: false, hasNewer: false }
	assert.deepEqual(mergeMessages(stored, [], rangeOfPage(empty, {}, null) as MessageRange), [])
})

test("an older page covers the stretch up to its cursor", () => {
	const stored = [1, 2, 3, 4, 5, 6].map((n) => msg(n))
	const page = { messages: [msg(2), msg(4)], hasMore: true, hasNewer: false }
	const range = rangeOfPage(page, { before: "m005" }, msg(5)) as MessageRange
	assert.deepEqual(ids(mergeMessages(stored, page.messages, range)), [1, 2, 4, 5, 6])
	// Unknown cursor: only the page's own span is replaced.
	const loose = rangeOfPage(page, { before: "m099" }, null) as MessageRange
	assert.deepEqual(ids(mergeMessages(stored, page.messages, loose)), [1, 2, 4, 5, 6])
})

test("pages are read back from the device the way the server pages them", () => {
	const stored = Array.from({ length: 10 }, (_, i) => msg(i + 1))
	const latest = pageFromStore(stored, { limit: 4 })
	assert.ok(latest)
	assert.deepEqual(ids(latest.messages), [7, 8, 9, 10])
	assert.equal(latest.hasMore, true)
	const older = pageFromStore(stored, { limit: 4, before: "m007" })
	assert.ok(older)
	assert.deepEqual(ids(older.messages), [3, 4, 5, 6])
	const oldest = pageFromStore(stored, { limit: 4, before: "m003" })
	assert.ok(oldest)
	assert.deepEqual(ids(oldest.messages), [1, 2])
	assert.equal(oldest.hasMore, false)
	assert.equal(pageFromStore(stored, { limit: 4, before: "m099" }), null)
	const around = pageFromStore(stored, { limit: 4, around: "m005" })
	assert.ok(around)
	assert.deepEqual(ids(around.messages), [3, 4, 5, 6])
	assert.equal(around.hasNewer, true)
	const after = pageFromStore(stored, { limit: 3, after: "m008" })
	assert.ok(after)
	assert.deepEqual(ids(after.messages), [9, 10])
	assert.equal(after.hasNewer, false)
	assert.deepEqual(pageFromStore([], { limit: 4 }), { messages: [], hasMore: false, hasNewer: false })
})

test("the newest messages are kept when a chat outgrows the cap", () => {
	const incoming = Array.from({ length: 12 }, (_, i) => msg(i + 1))
	assert.deepEqual(ids(mergeMessages([], incoming, everything, 5)), [8, 9, 10, 11, 12])
})

test("messages with the same time are ordered by id", () => {
	const at = "2026-10-01T00:00:00.000Z"
	const merged = mergeMessages([], [msg(2, { createdAt: at }), msg(1, { createdAt: at })], everything)
	assert.deepEqual(ids(merged), [1, 2])
})
