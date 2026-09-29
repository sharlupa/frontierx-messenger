// Convert an animated GIF into a compact muted video (MP4 when the browser can
// record it, otherwise WebM) by replaying the GIF onto a canvas and capturing
// the canvas stream. Falls back to the original file when canvas recording is
// unavailable so that uploading your own GIF always works.

export type ConvertedGif = { blob: Blob; url: string; mime: string }

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error("image load failed"))
		img.src = url
	})
}

function pickVideoMime(): string {
	const rec: any = (window as any).MediaRecorder
	if (rec && typeof rec.isTypeSupported === "function") {
		if (rec.isTypeSupported("video/mp4")) return "video/mp4"
		if (rec.isTypeSupported("video/webm;codecs=vp9")) return "video/webm;codecs=vp9"
		if (rec.isTypeSupported("video/webm")) return "video/webm"
	}
	return ""
}

export async function gifToVideo(file: File, maxMs = 6000): Promise<ConvertedGif> {
	const canRecord =
		typeof HTMLCanvasElement !== "undefined" &&
		typeof (HTMLCanvasElement.prototype as any).captureStream === "function" &&
		typeof (window as any).MediaRecorder !== "undefined"
	const targetMime = pickVideoMime()
	if (!file.type.includes("gif") || !canRecord || !targetMime) {
		return { blob: file, url: URL.createObjectURL(file), mime: file.type || "application/octet-stream" }
	}
	const sourceUrl = URL.createObjectURL(file)
	try {
		const img = await loadImage(sourceUrl)
		const width = img.naturalWidth || 320
		const height = img.naturalHeight || 320
		const canvas = document.createElement("canvas")
		canvas.width = width
		canvas.height = height
		const ctx = canvas.getContext("2d")
		if (!ctx) throw new Error("no 2d context")
		const stream: MediaStream = (canvas as any).captureStream(25)
		const recorder = new (window as any).MediaRecorder(stream, { mimeType: targetMime })
		const chunks: BlobPart[] = []
		recorder.ondataavailable = (event: any) => {
			if (event.data && event.data.size > 0) chunks.push(event.data)
		}
		const outMime = targetMime.split(";")[0]
		const recorded = new Promise<Blob>((resolve) => {
			recorder.onstop = () => resolve(new Blob(chunks, { type: outMime }))
		})
		const start = performance.now()
		let frame = 0
		const draw = () => {
			ctx.clearRect(0, 0, width, height)
			ctx.drawImage(img, 0, 0, width, height)
			if (performance.now() - start >= maxMs) {
				cancelAnimationFrame(frame)
				try { recorder.stop() } catch { /* ignore */ }
				return
			}
			frame = requestAnimationFrame(draw)
		}
		recorder.start()
		frame = requestAnimationFrame(draw)
		const blob = await recorded
		URL.revokeObjectURL(sourceUrl)
		if (!blob || blob.size === 0) {
			return { blob: file, url: URL.createObjectURL(file), mime: file.type || "image/gif" }
		}
		return { blob, url: URL.createObjectURL(blob), mime: outMime }
	} catch {
		URL.revokeObjectURL(sourceUrl)
		return { blob: file, url: URL.createObjectURL(file), mime: file.type || "image/gif" }
	}
}