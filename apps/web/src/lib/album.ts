import type { DisplayMessage } from "./types"
import type { MediaEnvelope } from "./media"

// Photos and videos sent together travel as separate messages that share an
// album id, so older apps still show every one of them. An album holds at
// most this many; more pictures make more albums.
export const ALBUM_MAX_ITEMS = 9

export type AlbumRef = { id: string; index: number; count: number }

// The album a message belongs to, if it says so plausibly. The value comes
// from the sender, so it is checked rather than trusted.
export function albumOf(media: MediaEnvelope | null | undefined): AlbumRef | null {
	const album = media?.album
	if (!album || typeof album !== "object") return null
	const { id, index, count } = album
	if (typeof id !== "string" || id.length === 0 || id.length > 64) return null
	if (!Number.isInteger(count) || count < 2 || count > ALBUM_MAX_ITEMS) return null
	if (!Number.isInteger(index) || index < 0 || index >= count) return null
	return { id, index, count }
}

export function newAlbumId(): string {
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

// Splits what is about to be sent into albums of at most ALBUM_MAX_ITEMS, in
// order. A group of one is sent as a plain message.
export function chunkIntoAlbums<T>(items: T[], max = ALBUM_MAX_ITEMS): Array<{ items: T[]; album: { id: string } | null }> {
	const out: Array<{ items: T[]; album: { id: string } | null }> = []
	for (let start = 0; start < items.length; start += max) {
		const chunk = items.slice(start, start + max)
		out.push({ items: chunk, album: chunk.length > 1 ? { id: newAlbumId() } : null })
	}
	return out
}

// Messages as the thread draws them: on their own, or as one album of
// consecutive messages from the same sender with the same album id. A deleted
// or unreadable message breaks the run.
export type ThreadUnit = { lead: DisplayMessage; members: DisplayMessage[] }

export function groupAlbums(messages: DisplayMessage[]): ThreadUnit[] {
	const units: ThreadUnit[] = []
	for (const message of messages) {
		const album = message.deleted || message.locked ? null : albumOf(message.media)
		const last = units[units.length - 1]
		const lastAlbum = last ? albumOf(last.lead.media) : null
		if (album && last && lastAlbum && lastAlbum.id === album.id && last.lead.senderId === message.senderId && last.members.length < ALBUM_MAX_ITEMS && !last.members[last.members.length - 1].deleted) {
			last.members.push(message)
			continue
		}
		units.push({ lead: message, members: [message] })
	}
	return units
}

// How many tiles go in each row of an album grid: wide rows first for a few
// pictures, three a row for many.
const ROWS: Record<number, number[]> = {
	1: [1],
	2: [2],
	3: [1, 2],
	4: [2, 2],
	5: [2, 3],
	6: [3, 3],
	7: [2, 2, 3],
	8: [2, 3, 3],
	9: [3, 3, 3],
}

export function albumRows(count: number): number[] {
	return ROWS[Math.max(1, Math.min(ALBUM_MAX_ITEMS, count))]
}
