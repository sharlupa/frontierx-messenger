// A message with a link preview travels as its own envelope inside the same
// end-to-end encrypted body: the readable text plus the card the sender built.
// Recipients therefore never fetch the linked page themselves, and the server
// sees the address only once, from the sender, at the moment it is composed.

export const LINK_PREFIX = "fxlink:1:"

export interface LinkPreviewCard {
	url: string
	title: string | null
	description: string | null
	siteName: string | null
	// Small JPEG data URL captured by the sender; may be absent.
	image: string | null
}

export interface LinkMessage {
	text: string
	preview: LinkPreviewCard
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i

export function firstUrl(text: string): string | null {
	const match = text.match(URL_PATTERN)
	if (!match) return null
	// Trailing punctuation is almost never part of the address.
	return match[0].replace(/[.,!?)\]]+$/, "")
}

export function encodeLinkMessage(message: LinkMessage): string {
	return LINK_PREFIX + JSON.stringify(message)
}

// The card is written by the sender, so every field is untrusted: the link
// must be a plain web address (a javascript: URL would run in the reader's
// session on click) and the picture must be an embedded raster image.
function safeWebUrl(value: unknown): string | null {
	if (typeof value !== "string") return null
	try {
		const url = new URL(value)
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
	} catch {
		return null
	}
}

function safeImage(value: unknown): string | null {
	if (typeof value !== "string") return null
	return /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value) ? value : null
}

function optionalText(value: unknown): string | null {
	return typeof value === "string" && value ? value : null
}

// A card that fails the checks is dropped and the message shows as plain text.
export function parseLinkMessage(text: string | null): { text: string; preview: LinkPreviewCard | null } | null {
	if (!text || !text.startsWith(LINK_PREFIX)) return null
	try {
		const data = JSON.parse(text.slice(LINK_PREFIX.length)) as LinkMessage
		if (!data || typeof data.text !== "string") return null
		const url = data.preview ? safeWebUrl(data.preview.url) : null
		if (!url) return { text: data.text, preview: null }
		return {
			text: data.text,
			preview: {
				url,
				title: optionalText(data.preview.title),
				description: optionalText(data.preview.description),
				siteName: optionalText(data.preview.siteName),
				image: safeImage(data.preview.image),
			},
		}
	} catch {
		return null
	}
}

// Shrink the sender-side image so the card costs a few kilobytes inside the
// message rather than the full-size picture from the page.
export async function shrinkPreviewImage(blob: Blob, maxEdge = 400, quality = 0.62): Promise<string | null> {
	if (typeof document === "undefined") return null
	const url = URL.createObjectURL(blob)
	try {
		const image = await new Promise<HTMLImageElement | null>((resolve) => {
			const element = new Image()
			element.onload = () => resolve(element)
			element.onerror = () => resolve(null)
			window.setTimeout(() => resolve(null), 4000)
			element.src = url
		})
		if (!image || !image.naturalWidth || !image.naturalHeight) return null
		const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
		const canvas = document.createElement("canvas")
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
		const context = canvas.getContext("2d")
		if (!context) return null
		context.drawImage(image, 0, 0, canvas.width, canvas.height)
		return canvas.toDataURL("image/jpeg", quality)
	} catch {
		return null
	} finally {
		URL.revokeObjectURL(url)
	}
}
