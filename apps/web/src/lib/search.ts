import { api } from "./api"
import type { Keyring } from "./keyring"
import type { MessageEnvelope } from "./types"
import { isSealedMessage } from "./keyvault"
import { parseMediaMessage, isVideoMedia } from "./media"
import { parsePollMessage } from "./poll"
import { parseLinkMessage } from "./linkmsg"
import { parseButtonMessage } from "./botmsg"
import { parseContact, parseLocation } from "./richmsg"
import { stripFormatting } from "./richtext"

// Search across every chat. Messages are end-to-end encrypted, so the server
// hands out ciphertext page by page and this device decrypts and matches.
// The readable text lives in memory only, for as long as the app is open.

export type SearchKind = "text" | "link" | "photo" | "video" | "file" | "voice" | "poll" | "location" | "contact"
export type SearchFilter = "all" | "media" | "links" | "files" | "voice" | "places"

export type SearchItem = {
	id: string
	conversationId: string
	senderId: string
	createdAt: string
	kind: SearchKind
	// What is shown and matched: the text, a caption, a file name...
	text: string
	norm: string
	url?: string
}

const MAX_ITEMS = 30000
const PAGE = 500

export function normalize(text: string): string {
	return text
		.toLocaleLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ё/g, "е")
		.replace(/\s+/g, " ")
}

function describe(plain: string): Omit<SearchItem, "id" | "conversationId" | "senderId" | "createdAt" | "norm"> {
	const media = parseMediaMessage(plain)
	if (media) {
		const kind: SearchKind = media.kind === "voice" ? "voice" : media.kind === "image" ? "photo" : isVideoMedia(media) ? "video" : "file"
		const text = media.spoiler ? (media.kind === "file" ? media.name : "") : [media.caption ?? "", kind === "file" ? media.name : ""].filter(Boolean).join(" · ")
		return { kind, text: stripSpoilers(text) }
	}
	const poll = parsePollMessage(plain)
	if (poll) return { kind: "poll", text: [poll.question, ...poll.options].join(" · ") }
	const location = parseLocation(plain)
	if (location) return { kind: "location", text: location.label ?? location.lat.toFixed(5) + ", " + location.lon.toFixed(5) }
	const contact = parseContact(plain)
	if (contact) return { kind: "contact", text: [contact.displayName, contact.username ? "@" + contact.username : "", contact.phone ?? "", contact.email ?? ""].filter(Boolean).join(" ") }
	const buttons = parseButtonMessage(plain)
	if (buttons) {
		const text = stripSpoilers(stripFormatting(buttons.text))
		return { kind: "text", text: [text, ...buttons.buttons.flat().map((button) => button.text)].filter(Boolean).join(" · ") }
	}
	const link = parseLinkMessage(plain)
	if (link) return { kind: "link", text: stripSpoilers(stripFormatting(link.text)) + (link.preview?.title ? " · " + link.preview.title : ""), url: link.preview?.url }
	const text = stripSpoilers(stripFormatting(plain))
	const url = /https?:\/\/[^\s<]+/.exec(text)
	return { kind: url ? "link" : "text", text, url: url ? url[0] : undefined }
}

// Hidden text stays hidden in results too.
function stripSpoilers(text: string): string {
	return text.replace(/\|\|([^|\n]+)\|\|/g, (_match, inner: string) => "•".repeat(Math.min(12, inner.length)))
}

export class SearchEngine {
	private items: SearchItem[] = []
	private seen = new Set<string>()
	private cursor: string | null = null
	private running: Promise<void> | null = null
	done = false
	scanned = 0

	constructor(private readonly keyring: Keyring) {}

	get size(): number {
		return this.items.length
	}

	private async add(message: MessageEnvelope, front = false): Promise<void> {
		if (this.seen.has(message.id) || message.deletedAt || !message.ciphertext) return
		let plain: string
		try {
			plain = isSealedMessage(message.ciphertext) ? await this.keyring.decrypt(message.conversationId, message.ciphertext) : message.ciphertext
		} catch {
			return
		}
		const described = describe(plain)
		const item: SearchItem = { id: message.id, conversationId: message.conversationId, senderId: message.senderId, createdAt: message.createdAt, ...described, norm: normalize(described.text) }
		this.seen.add(message.id)
		if (front) this.items.unshift(item)
		else this.items.push(item)
	}

	// Pulls the next pages of history (newest first) until everything is
	// indexed or the memory budget is used up. Safe to call repeatedly.
	scan(onProgress?: () => void): Promise<void> {
		if (this.done) return Promise.resolve()
		if (this.running) return this.running
		this.running = (async () => {
			while (!this.done && this.items.length < MAX_ITEMS) {
				const page = await api.searchCorpus({ before: this.cursor, limit: PAGE })
				for (const message of page.messages) {
					await this.add(message)
					this.scanned += 1
				}
				this.cursor = page.nextBefore
				if (!page.nextBefore) this.done = true
				if (onProgress) onProgress()
			}
			this.done = true
		})().finally(() => {
			this.running = null
		})
		return this.running
	}

	// New messages join the index as they arrive.
	async addLive(message: MessageEnvelope): Promise<void> {
		await this.add(message, true)
	}

	search(query: string, filter: SearchFilter, limit = 200): SearchItem[] {
		const terms = normalize(query).trim().split(" ").filter(Boolean)
		const out: SearchItem[] = []
		for (const item of this.items) {
			if (!matchesFilter(item, filter)) continue
			if (terms.length > 0 && !terms.every((term) => item.norm.includes(term))) continue
			if (terms.length === 0 && filter === "all") continue
			out.push(item)
			if (out.length >= limit) break
		}
		return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
	}
}

function matchesFilter(item: SearchItem, filter: SearchFilter): boolean {
	switch (filter) {
		case "media":
			return item.kind === "photo" || item.kind === "video"
		case "links":
			return item.kind === "link"
		case "files":
			return item.kind === "file"
		case "voice":
			return item.kind === "voice"
		case "places":
			return item.kind === "location" || item.kind === "contact"
		default:
			return true
	}
}

// Text around the first match, for the result row.
export function snippet(text: string, query: string, radius = 48): { before: string; match: string; after: string } | null {
	const term = normalize(query).trim().split(" ").filter(Boolean)[0]
	if (!term) return { before: text.slice(0, radius * 2), match: "", after: "" }
	const norm = normalize(text)
	const at = norm.indexOf(term)
	if (at < 0) return { before: text.slice(0, radius * 2), match: "", after: "" }
	// Normalisation keeps lengths for the scripts that matter here closely
	// enough to cut the original text at the same place.
	const start = Math.max(0, at - radius)
	const end = Math.min(text.length, at + term.length + radius)
	return {
		before: (start > 0 ? "…" : "") + text.slice(start, at),
		match: text.slice(at, at + term.length),
		after: text.slice(at + term.length, end) + (end < text.length ? "…" : ""),
	}
}
