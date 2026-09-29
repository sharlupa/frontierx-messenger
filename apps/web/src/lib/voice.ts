// Voice message recording. The recorder captures microphone audio with
// MediaRecorder, measures the elapsed time itself (container metadata from a
// live recording is often missing a duration) and samples the input level so
// the composer can draw a live meter and the sent message can carry a static
// waveform outline.

export const WAVEFORM_BARS = 48

export interface VoiceRecording {
	bytes: Uint8Array
	mime: string
	// Seconds of audio, rounded to one decimal.
	duration: number
	// Amplitude peaks scaled to 0..100, one per drawn bar.
	waveform: number[]
}

// Ordered by preference: Opus in WebM is what Chromium-based browsers, the
// Android WebView and Electron all produce and play; the mp4/aac entries are
// the fallback for WebKit.
const MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/ogg;codecs=opus",
	"audio/mp4;codecs=mp4a.40.2",
	"audio/mp4",
]

// Safari (and every browser on iPhone and iPad, which all run WebKit) records
// AAC in mp4 first: newer versions can also write WebM, but older iPhones
// cannot play that back, while AAC plays everywhere.
const WEBKIT_CANDIDATES = [
	"audio/mp4;codecs=mp4a.40.2",
	"audio/mp4",
	"audio/aac",
	"audio/webm;codecs=opus",
	"audio/webm",
]

function isWebKit(): boolean {
	if (typeof navigator === "undefined") return false
	const ua = navigator.userAgent || ""
	return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR|Android)\//.test(ua)
}

export function voiceRecordingSupported(): boolean {
	if (typeof window === "undefined") return false
	if (typeof MediaRecorder === "undefined") return false
	const media = navigator.mediaDevices
	return Boolean(media && typeof media.getUserMedia === "function")
}

export function pickVoiceMime(): string {
	if (typeof MediaRecorder === "undefined") return "audio/webm"
	for (const candidate of isWebKit() ? WEBKIT_CANDIDATES : MIME_CANDIDATES) {
		try {
			if (MediaRecorder.isTypeSupported(candidate)) return candidate
		} catch {
			// Older implementations throw instead of returning false.
		}
	}
	return ""
}

export function voiceExtension(mime: string): string {
	if (mime.indexOf("ogg") >= 0) return "ogg"
	if (mime.indexOf("mp4") >= 0 || mime.indexOf("aac") >= 0 || mime.indexOf("mpeg") >= 0) return "m4a"
	return "webm"
}

export function isVoiceMime(mime: string): boolean {
	return mime.indexOf("audio/") === 0
}

export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds))
	const mins = Math.floor(total / 60)
	const secs = total % 60
	return String(mins) + ":" + (secs < 10 ? "0" : "") + String(secs)
}

// Reduce the peaks collected while recording to a fixed number of bars, so a
// three second note and a three minute note both draw the same width.
export function resampleWaveform(peaks: number[], bars = WAVEFORM_BARS): number[] {
	if (peaks.length === 0) return new Array(bars).fill(6)
	const out: number[] = []
	for (let i = 0; i < bars; i++) {
		const start = Math.floor((i * peaks.length) / bars)
		const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / bars))
		let peak = 0
		for (let j = start; j < end && j < peaks.length; j++) {
			if (peaks[j] > peak) peak = peaks[j]
		}
		out.push(peak)
	}
	// Normalise against the loudest bar so quiet recordings still show relief.
	let loudest = 0
	for (const value of out) if (value > loudest) loudest = value
	const scale = loudest > 0 ? 100 / loudest : 0
	return out.map((value) => {
		const scaled = Math.round(value * scale)
		return Math.max(6, Math.min(100, scaled))
	})
}


// Input level meter shared by the composer and the call bar, so "am I being
// heard" looks and behaves the same in both places. Returns a stop function.
// An existing AudioContext can be passed in - a call already owns one that was
// unlocked by the tap that started it, and mobile browsers refuse to run a
// fresh one outside a user gesture.
export function startLevelMeter(
	stream: MediaStream,
	onLevel: (level: number) => void,
	options?: { context?: AudioContext | null; intervalMs?: number },
): () => void {
	let stop = () => undefined as void
	try {
		const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
		let shared = options?.context ?? null
		let context = shared ?? (Ctor ? new Ctor() : null)
		if (!context) return stop
		let analyser = context.createAnalyser()
		analyser.fftSize = 1024
		let source: MediaStreamAudioSourceNode
		try {
			source = context.createMediaStreamSource(stream)
		} catch {
			// A shared context can refuse a stream recorded at another sample
			// rate; a context of our own always accepts it.
			if (!shared || !Ctor) return stop
			context = new Ctor()
			shared = null
			analyser = context.createAnalyser()
			analyser.fftSize = 1024
			source = context.createMediaStreamSource(stream)
		}
		source.connect(analyser)
		const buffer = new Uint8Array(analyser.fftSize)
		const timer = window.setInterval(() => {
			if (context.state === "suspended") void context.resume().catch(() => undefined)
			analyser.getByteTimeDomainData(buffer)
			let sum = 0
			for (let i = 0; i < buffer.length; i++) {
				const deviation = (buffer[i] - 128) / 128
				sum += deviation * deviation
			}
			// Root-mean-square of the frame, stretched so ordinary speech lands
			// in the upper half of the meter instead of hugging zero.
			const rms = Math.sqrt(sum / buffer.length)
			onLevel(Math.max(0, Math.min(100, Math.round(Math.sqrt(rms) * 140))))
		}, options?.intervalMs ?? 100)
		stop = () => {
			window.clearInterval(timer)
			try {
				source.disconnect()
			} catch {
				// Already torn down with its context.
			}
			// Only a context created here may be closed.
			if (!shared) void context.close().catch(() => undefined)
		}
	} catch {
		// Metering is optional: without it the recorder and the call still work.
	}
	return stop
}

export class VoiceRecorder {
	private stream: MediaStream | null = null
	private recorder: MediaRecorder | null = null
	private stopMeter: (() => void) | null = null
	private chunks: BlobPart[] = []
	private peaks: number[] = []
	private startedAt = 0
	private mime = ""
	private stopped = false

	// Called roughly ten times a second with the current input level (0..100),
	// so the composer can animate a live meter.
	onLevel: ((level: number) => void) | null = null

	get active(): boolean {
		return this.recorder !== null && !this.stopped
	}

	get elapsed(): number {
		if (!this.startedAt) return 0
		return (Date.now() - this.startedAt) / 1000
	}

	async start(): Promise<void> {
		if (!voiceRecordingSupported()) throw new Error("unsupported")
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		})
		this.stream = stream
		this.mime = pickVoiceMime()
		const recorder = this.mime ? new MediaRecorder(stream, { mimeType: this.mime }) : new MediaRecorder(stream)
		if (!this.mime) this.mime = recorder.mimeType || "audio/webm"
		this.recorder = recorder
		this.chunks = []
		this.peaks = []
		this.stopped = false
		recorder.ondataavailable = (event: BlobEvent) => {
			if (event.data && event.data.size > 0) this.chunks.push(event.data)
		}
		recorder.start(250)
		this.startedAt = Date.now()
		this.listenLevels(stream)
	}

	private listenLevels(stream: MediaStream) {
		this.stopMeter = startLevelMeter(stream, (level) => {
			this.peaks.push(level)
			if (this.onLevel) this.onLevel(level)
		})
	}

	// Stop recording and return the encoded audio. Resolves with null when
	// nothing was captured.
	async stop(): Promise<VoiceRecording | null> {
		const recorder = this.recorder
		if (!recorder || this.stopped) {
			this.release()
			return null
		}
		this.stopped = true
		const duration = this.elapsed
		const blob = await new Promise<Blob>((resolve) => {
			recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.mime }))
			try {
				recorder.stop()
			} catch {
				resolve(new Blob(this.chunks, { type: this.mime }))
			}
		})
		const peaks = this.peaks.slice()
		this.release()
		if (blob.size === 0) return null
		const bytes = new Uint8Array(await blob.arrayBuffer())
		return {
			bytes,
			mime: this.mime || "audio/webm",
			duration: Math.max(0.1, Math.round(duration * 10) / 10),
			waveform: resampleWaveform(peaks),
		}
	}

	// Drop the recording without producing a file.
	cancel(): void {
		const recorder = this.recorder
		this.stopped = true
		if (recorder && recorder.state !== "inactive") {
			recorder.onstop = null
			try {
				recorder.stop()
			} catch {
				// Already stopping; the tracks are released below either way.
			}
		}
		this.chunks = []
		this.peaks = []
		this.release()
	}

	private release(): void {
		if (this.stopMeter) {
			this.stopMeter()
			this.stopMeter = null
		}
		if (this.stream) {
			for (const track of this.stream.getTracks()) track.stop()
			this.stream = null
		}
		this.recorder = null
		this.onLevel = null
	}
}
