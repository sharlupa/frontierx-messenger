// Messages from bots with buttons under them. Like everything else they are
// plain JSON behind a prefix inside the end-to-end encrypted message body:
//
//   fxbtn:1:{"text":"Choose a plan","buttons":[[{"text":"Month","data":"buy:month"}],[{"text":"Site","url":"https://…"}]]}
//
// A button either sends its data back to the bot (sealed with the chat key,
// so the server never sees what was pressed) or opens an https link. Buttons
// are only drawn under messages whose sender is a bot. Attachments carry the
// same rows in their envelope ("buttons").

export const BUTTONS_PREFIX = "fxbtn:1:"

export type BotButton = { text: string; data?: string; url?: string }
export type ButtonMessage = { text: string; buttons: BotButton[][] }

const MAX_ROWS = 8
const MAX_PER_ROW = 8
const MAX_LABEL = 64
const MAX_DATA = 256

function cleanUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 2048) return null
	try {
		const url = new URL(value)
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
	} catch {
		return null
	}
}

// Keeps only well-formed buttons; anything else in the rows is dropped.
export function sanitizeButtons(raw: unknown): BotButton[][] | null {
	if (!Array.isArray(raw)) return null
	const rows: BotButton[][] = []
	for (const row of raw.slice(0, MAX_ROWS)) {
		if (!Array.isArray(row)) continue
		const out: BotButton[] = []
		for (const item of row.slice(0, MAX_PER_ROW)) {
			if (!item || typeof item !== "object") continue
			const record = item as Record<string, unknown>
			const text = typeof record.text === "string" ? record.text.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : ""
			if (!text) continue
			const url = cleanUrl(record.url)
			if (url) {
				out.push({ text, url })
				continue
			}
			if (typeof record.data === "string" && record.data.length > 0 && record.data.length <= MAX_DATA) out.push({ text, data: record.data })
		}
		if (out.length > 0) rows.push(out)
	}
	return rows.length > 0 ? rows : null
}

export function parseButtonMessage(text: string | null): ButtonMessage | null {
	if (!text || !text.startsWith(BUTTONS_PREFIX)) return null
	try {
		const raw = JSON.parse(text.slice(BUTTONS_PREFIX.length)) as Record<string, unknown>
		const body = typeof raw.text === "string" ? raw.text : ""
		return { text: body, buttons: sanitizeButtons(raw.buttons) ?? [] }
	} catch {
		return null
	}
}
