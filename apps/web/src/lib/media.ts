import { decryptFile, decryptFileToBlob, encryptFile, encryptFileToBlob, randomFileKey, type FileManifest } from "./filecrypto"

// Envelope carried INSIDE an end-to-end encrypted chat message. It names the
// encrypted blob stored on the server plus the per-file data key and manifest
// needed to decrypt it. Because the whole envelope travels inside the
// passphrase-encrypted message body, the server never sees the data key or the
// plaintext bytes: it only ever holds ciphertext. Every member of the
// conversation can therefore download and decrypt the attachment.

export const MEDIA_PREFIX = "fxmedia:1:"
const GCM_TAG_BYTES = 16

export type MediaKind = "image" | "file" | "voice"

export interface MediaEnvelope {
	kind: MediaKind
	fileId: string
	name: string
	mime: string
	size: number
	key: string
	manifest: FileManifest
	caption?: string
	// Voice messages carry their length in seconds and a coarse amplitude
	// outline so the bubble can draw and seek a waveform without first
	// downloading and decoding the audio. Video attachments reuse duration and
	// add a small still frame plus the frame size, so the bubble can show a
	// real preview at the right shape before anything is downloaded.
	duration?: number
	waveform?: number[]
	poster?: string
	width?: number
	height?: number
	// Shown blurred until the reader taps it.
	spoiler?: boolean
	// A bot's buttons under the attachment.
	buttons?: unknown
}

// Browsers leave File.type empty for containers they do not know (.mkv, .m4v
// from some tools), which would hide a perfectly playable video behind a
// generic file card. The extension is the fallback.
const MIME_BY_EXTENSION: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	ogv: "video/ogg",
	"3gp": "video/3gpp",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	wav: "audio/wav",
	flac: "audio/flac",
}

export function guessMime(name: string, provided: string): string {
	if (provided && provided !== "application/octet-stream") return provided
	const dot = name.lastIndexOf(".")
	if (dot < 0) return provided || "application/octet-stream"
	const ext = name.slice(dot + 1).toLowerCase()
	return MIME_BY_EXTENSION[ext] ?? (provided || "application/octet-stream")
}

export function isVideoMedia(media: MediaEnvelope): boolean {
	return media.kind !== "voice" && media.kind !== "image" && guessMime(media.name, media.mime).indexOf("video/") === 0
}

export function isAudioMedia(media: MediaEnvelope): boolean {
	return media.kind !== "voice" && guessMime(media.name, media.mime).indexOf("audio/") === 0
}

// GIFs sent from the picker travel as short muted clips and should keep
// looping by themselves; a real video gets a player instead.
export function isAnimatedMedia(media: MediaEnvelope): boolean {
	if (media.mime === "image/gif") return true
	return media.name.indexOf("animation.") === 0
}

function bytesToB64(bytes: Uint8Array): string {
	let binary = ""
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary)
}

function b64ToBytes(value: string): Uint8Array {
	const binary = atob(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

function concatBlobs(blobs: Uint8Array[]): Uint8Array {
	let total = 0
	for (const b of blobs) total += b.length
	const merged = new Uint8Array(total)
	let offset = 0
	for (const b of blobs) {
		merged.set(b, offset)
		offset += b.length
	}
	return merged
}

function splitBlobs(cipher: Uint8Array, manifest: FileManifest): Uint8Array[] {
	const blobs: Uint8Array[] = []
	let offset = 0
	for (const chunk of manifest.chunks) {
		const sealed = chunk.length + GCM_TAG_BYTES
		blobs.push(cipher.subarray(offset, offset + sealed))
		offset += sealed
	}
	return blobs
}

function kindForMime(mime: string): MediaKind {
	return mime.indexOf("image/") === 0 ? "image" : "file"
}

// Encrypt raw file bytes for a specific file id. Returns the ciphertext to
// upload to the blob store plus the envelope to embed in the chat message.
export async function packFile(
	fileId: string,
	name: string,
	mime: string,
	plaintext: Uint8Array,
	extra?: Partial<MediaEnvelope>,
): Promise<{ cipher: Uint8Array; envelope: MediaEnvelope }> {
	const rawKey = randomFileKey()
	const encrypted = await encryptFile(rawKey, plaintext, fileId)
	const cipher = concatBlobs(encrypted.blobs)
	const envelope: MediaEnvelope = {
		kind: kindForMime(mime),
		fileId,
		name,
		mime,
		size: plaintext.length,
		key: bytesToB64(rawKey),
		manifest: encrypted.manifest,
	}
	// Callers describing richer media (a voice note, for instance) may override
	// the derived kind and add their own descriptive fields. The file id, key
	// and manifest stay as produced here so the envelope still decrypts.
	if (extra) {
		Object.assign(envelope, extra, { fileId, key: envelope.key, manifest: envelope.manifest })
	}
	return { cipher, envelope }
}

// Chat attachments take this path: the file is encrypted straight into a Blob,
// so a large video never needs a second full copy in memory.
export async function packFileFromBlob(
	fileId: string,
	name: string,
	mime: string,
	source: Blob,
	extra?: Partial<MediaEnvelope>,
	onProgress?: (ratio: number) => void,
): Promise<{ blob: Blob; envelope: MediaEnvelope }> {
	const rawKey = randomFileKey()
	const encrypted = await encryptFileToBlob(rawKey, source, fileId, onProgress)
	const envelope: MediaEnvelope = {
		kind: kindForMime(mime),
		fileId,
		name,
		mime,
		size: source.size,
		key: bytesToB64(rawKey),
		manifest: encrypted.manifest,
	}
	if (extra) {
		Object.assign(envelope, extra, { fileId, key: envelope.key, manifest: envelope.manifest })
	}
	return { blob: encrypted.blob, envelope }
}

export const packImage = packFile

export async function unpackFile(envelope: MediaEnvelope, cipher: Uint8Array): Promise<Uint8Array> {
	const rawKey = b64ToBytes(envelope.key)
	const blobs = splitBlobs(cipher, envelope.manifest)
	return decryptFile(rawKey, envelope.manifest, blobs)
}

// Playback path: decrypt straight into a Blob that can back an object URL.
export async function unpackFileToBlob(
	envelope: MediaEnvelope,
	cipher: Uint8Array,
	onProgress?: (ratio: number) => void,
): Promise<Blob> {
	const rawKey = b64ToBytes(envelope.key)
	return decryptFileToBlob(rawKey, envelope.manifest, cipher, envelope.mime, onProgress)
}

export const unpackImage = unpackFile

export function encodeMediaMessage(envelope: MediaEnvelope): string {
	return MEDIA_PREFIX + JSON.stringify(envelope)
}

export function parseMediaMessage(text: string | null): MediaEnvelope | null {
	if (!text) return null
	if (!text.startsWith(MEDIA_PREFIX)) return null
	try {
		const data = JSON.parse(text.slice(MEDIA_PREFIX.length)) as MediaEnvelope
		if (data && (data.kind === "image" || data.kind === "file" || data.kind === "voice") && typeof data.fileId === "string" && data.manifest) {
			return data
		}
		return null
	} catch {
		return null
	}
}