// Small pictures made from a photo on this device: a thumbnail for the strip
// of attachments waiting to be sent, and a tiny blurred preview with the
// photo's size that travels inside the encrypted message. With that preview
// a bubble keeps the photo's shape before the file arrives, and a spoiler
// shows a blurred hint of what is under it instead of an empty box.

export interface ImageInfo {
	width: number | null
	height: number | null
	poster: string | null
}

// The preview is meant to be blurred, so a few dozen pixels are plenty and
// keep the message small.
const POSTER_EDGE = 32
const POSTER_QUALITY = 0.6
const THUMB_EDGE = 320
const THUMB_QUALITY = 0.8

async function decode(file: Blob, resizeWidth?: number): Promise<ImageBitmap | null> {
	if (typeof createImageBitmap !== "function") return null
	try {
		// EXIF orientation is applied, so phone photos are the right way up.
		return await createImageBitmap(file, resizeWidth ? { resizeWidth, resizeQuality: "medium", imageOrientation: "from-image" } : { imageOrientation: "from-image" })
	} catch {
		return null
	}
}

function drawScaled(source: CanvasImageSource, width: number, height: number, edge: number): HTMLCanvasElement | null {
	const scale = Math.min(1, edge / Math.max(width, height))
	const canvas = document.createElement("canvas")
	canvas.width = Math.max(1, Math.round(width * scale))
	canvas.height = Math.max(1, Math.round(height * scale))
	const context = canvas.getContext("2d")
	if (!context) return null
	// JPEG has no transparency: see-through parts would turn black.
	context.fillStyle = "#ffffff"
	context.fillRect(0, 0, canvas.width, canvas.height)
	context.drawImage(source, 0, 0, canvas.width, canvas.height)
	return canvas
}

export async function describeImage(file: Blob): Promise<ImageInfo> {
	const empty: ImageInfo = { width: null, height: null, poster: null }
	if (typeof document === "undefined") return empty
	const bitmap = await decode(file)
	if (!bitmap) return empty
	try {
		const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, POSTER_EDGE)
		return { width: bitmap.width, height: bitmap.height, poster: canvas ? canvas.toDataURL("image/jpeg", POSTER_QUALITY) : null }
	} catch {
		return { width: bitmap.width, height: bitmap.height, poster: null }
	} finally {
		bitmap.close()
	}
}

// An object URL of a small copy, decoded at reduced size so a dozen camera
// photos do not have to be decoded in full just to fill the strip. Null when
// the browser cannot read the format (HEIC in most of them).
export async function thumbnailUrl(file: Blob): Promise<string | null> {
	if (typeof document === "undefined") return null
	const bitmap = await decode(file, THUMB_EDGE)
	if (!bitmap) return null
	try {
		const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, THUMB_EDGE)
		if (!canvas) return null
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", THUMB_QUALITY))
		return blob ? URL.createObjectURL(blob) : null
	} finally {
		bitmap.close()
	}
}

// A preview from someone else's message is shown only if it is an inline
// picture: a web address would make the device fetch it and give away that
// the message was opened, and from where.
export function safePreview(value: unknown): string | null {
	return typeof value === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null
}
