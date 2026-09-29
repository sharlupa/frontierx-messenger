// Still frame captured from a video the moment it is attached. The frame and
// the duration travel inside the encrypted message envelope, so a video bubble
// can show a real preview and its length without downloading the file first.

export interface VideoPoster {
	poster: string | null
	duration: number | null
	width: number | null
	height: number | null
}

const POSTER_MAX_EDGE = 480
const POSTER_QUALITY = 0.62
// A frame from the very start is often black, so seek a little in - but never
// past the end of a very short clip.
const POSTER_SEEK_SECONDS = 0.8

export async function captureVideoPoster(file: File): Promise<VideoPoster> {
	const empty: VideoPoster = { poster: null, duration: null, width: null, height: null }
	if (typeof document === "undefined") return empty
	const url = URL.createObjectURL(file)
	const video = document.createElement("video")
	video.preload = "metadata"
	video.muted = true
	video.playsInline = true
	try {
		const metadata = await new Promise<boolean>((resolve) => {
			const done = (ok: boolean) => resolve(ok)
			video.onloadedmetadata = () => done(true)
			video.onerror = () => done(false)
			// A container the browser cannot decode must not hold up the send.
			window.setTimeout(() => done(false), 4000)
			video.src = url
		})
		if (!metadata) return empty
		const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
		const width = video.videoWidth || null
		const height = video.videoHeight || null
		const seekTo = duration ? Math.min(POSTER_SEEK_SECONDS, duration / 2) : 0
		const seeked = await new Promise<boolean>((resolve) => {
			const done = (ok: boolean) => resolve(ok)
			video.onseeked = () => done(true)
			video.onerror = () => done(false)
			window.setTimeout(() => done(false), 4000)
			try {
				video.currentTime = seekTo
			} catch {
				done(false)
			}
		})
		if (!seeked || !width || !height) return { poster: null, duration, width, height }
		const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(width, height))
		const canvas = document.createElement("canvas")
		canvas.width = Math.max(1, Math.round(width * scale))
		canvas.height = Math.max(1, Math.round(height * scale))
		const context = canvas.getContext("2d")
		if (!context) return { poster: null, duration, width, height }
		context.drawImage(video, 0, 0, canvas.width, canvas.height)
		let poster: string | null = null
		try {
			poster = canvas.toDataURL("image/jpeg", POSTER_QUALITY)
		} catch {
			// A tainted canvas cannot be read; the bubble then falls back to a
			// plain placeholder.
			poster = null
		}
		return { poster, duration, width, height }
	} catch {
		return empty
	} finally {
		video.removeAttribute("src")
		video.load()
		URL.revokeObjectURL(url)
	}
}
