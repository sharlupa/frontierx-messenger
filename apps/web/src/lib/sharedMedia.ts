import { api } from "./api"
import { parseButtonMessage } from "./botmsg"
import { activeKeyring } from "./keyring"
import { parseLinkMessage } from "./linkmsg"
import { isAnimatedMedia, isVideoMedia, parseMediaMessage, type MediaEnvelope } from "./media"

// What a chat has shared, for the tabs of a profile. Messages are end-to-end
// encrypted, so the server cannot answer "the photos of this chat": the
// history is fetched page by page and sorted out here, after decryption.

export type SharedMediaItem = { messageId: string; senderId: string; createdAt: string; media: MediaEnvelope }
export type SharedLink = {
	messageId: string
	senderId: string
	createdAt: string
	url: string
	title: string | null
	description: string | null
	image: string | null
}
export type SharedContent = {
	media: SharedMediaItem[]
	files: SharedMediaItem[]
	links: SharedLink[]
	gifs: SharedMediaItem[]
	// False when the walk stopped at the limit before the start of the chat.
	complete: boolean
}

export const EMPTY_SHARED: SharedContent = { media: [], files: [], links: [], gifs: [], complete: false }

const PAGE = 200
const MAX_PAGES = 15
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

// Addresses written in the text; a hidden spoiler stays hidden here too.
export function linksInText(text: string): string[] {
	const visible = text.replace(/\|\|([^|\n]+)\|\|/g, " ")
	const out: string[] = []
	for (const match of visible.matchAll(URL_RE)) {
		let url = match[0].replace(/[.,!?;:]+$/, "")
		// A closing bracket belongs to the address only if it opened one.
		while (/[)\]]$/.test(url) && (url.match(/[(\[]/g)?.length ?? 0) < (url.match(/[)\]]/g)?.length ?? 0)) url = url.slice(0, -1)
		try {
			const parsed = new URL(url)
			if (parsed.protocol === "https:" || parsed.protocol === "http:") out.push(parsed.toString())
		} catch {
			// not an address after all
		}
	}
	return out
}

// Sorts one decrypted message into the tabs (newest first, like the walk).
export function classifyMessage(out: SharedContent, envelope: { id: string; senderId: string; createdAt: string }, text: string) {
	const base = { messageId: envelope.id, senderId: envelope.senderId, createdAt: envelope.createdAt }
	const media = parseMediaMessage(text)
	if (media) {
		if (media.kind === "voice") return
		if (isAnimatedMedia(media)) out.gifs.push({ ...base, media })
		else if (media.kind === "image" || isVideoMedia(media)) out.media.push({ ...base, media })
		else out.files.push({ ...base, media })
		if (media.caption) for (const url of linksInText(media.caption)) out.links.push({ ...base, url, title: null, description: null, image: null })
		return
	}
	const link = parseLinkMessage(text)
	const buttons = link ? null : parseButtonMessage(text)
	const body = link ? link.text : buttons ? buttons.text : text
	const seen = new Set<string>()
	if (link?.preview) {
		seen.add(link.preview.url)
		out.links.push({ ...base, url: link.preview.url, title: link.preview.title, description: link.preview.description ?? link.preview.siteName, image: link.preview.image })
	}
	for (const url of linksInText(body)) {
		if (seen.has(url)) continue
		seen.add(url)
		out.links.push({ ...base, url, title: null, description: null, image: null })
	}
}

// Walks the chat from the newest message back, reporting what it has found
// after every page so the tabs fill in while it runs.
export async function loadSharedContent(
	conversationId: string,
	options: { skipReplies?: boolean; signal?: { cancelled: boolean }; onPage?: (partial: SharedContent) => void } = {},
): Promise<SharedContent> {
	const keyring = activeKeyring()
	const out: SharedContent = { media: [], files: [], links: [], gifs: [], complete: false }
	if (!keyring) return out
	await keyring.load(conversationId).catch(() => undefined)
	let before: string | null = null
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await api.listMessages(conversationId, { limit: PAGE, before })
		if (options.signal?.cancelled) return out
		const batch = res.messages.slice().reverse()
		for (const message of batch) {
			if (message.deletedAt) continue
			if (options.skipReplies && message.replyTo) continue
			let text: string
			try {
				text = await keyring.decrypt(conversationId, message.ciphertext)
			} catch {
				continue
			}
			classifyMessage(out, message, text)
		}
		if (options.signal?.cancelled) return out
		if (res.messages.length === 0 || !res.hasMore) {
			out.complete = true
			break
		}
		before = res.messages[0].id
		options.onPage?.({ ...out, media: out.media.slice(), files: out.files.slice(), links: out.links.slice(), gifs: out.gifs.slice() })
	}
	return out
}
