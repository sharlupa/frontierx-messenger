// Local-first file encryption for the browser (WebCrypto AES-256-GCM).
// Order: chunk -> encrypt each chunk with AES-GCM (AEAD binds fileId + index)
// -> build a signed manifest (SHA-256 over the canonical manifest). Mirrors the
// Node @frontierx/crypto file format but runs in the browser so the data key
// never leaves the device. Encrypted blobs are held locally in v1; shipping
// them to encrypted temp server backup is the documented next step and does
// not change this on-device format.

const subtle = globalThis.crypto.subtle

export const FILE_ALGO = "AES-256-GCM"
export const KEY_BYTES = 32
export const IV_BYTES = 12
export const DEFAULT_CHUNK = 64 * 1024

export interface ChunkMeta {
	index: number
	iv: string
	length: number
}

export interface FileManifest {
	version: 1
	algo: string
	fileId: string
	size: number
	chunkSize: number
	chunkCount: number
	chunks: ChunkMeta[]
	manifestHash: string
}

export interface EncryptedFile {
	manifest: FileManifest
	blobs: Uint8Array[]
}

function ab(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function b64(bytes: Uint8Array): string {
	let s = ""
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
	return btoa(s)
}

function unb64(text: string): Uint8Array {
	const bin = atob(text)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

export function randomFileKey(): Uint8Array {
	const key = new Uint8Array(KEY_BYTES)
	globalThis.crypto.getRandomValues(key)
	return key
}

function aadFor(fileId: string, index: number): Uint8Array {
	return new TextEncoder().encode(fileId + ":" + index)
}

async function sha256b64(bytes: Uint8Array): Promise<string> {
	const digest = await subtle.digest("SHA-256", ab(bytes))
	return b64(new Uint8Array(digest))
}

function canonicalBytes(base: Omit<FileManifest, "manifestHash">): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(base))
}

async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
	return subtle.importKey("raw", ab(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

export async function encryptFile(
	rawKey: Uint8Array,
	plaintext: Uint8Array,
	fileId: string,
	chunkSize: number = DEFAULT_CHUNK,
): Promise<EncryptedFile> {
	const key = await importKey(rawKey)
	const chunkCount = Math.max(1, Math.ceil(plaintext.length / chunkSize))
	const chunks: ChunkMeta[] = []
	const blobs: Uint8Array[] = []
	for (let i = 0; i < chunkCount; i++) {
		const start = i * chunkSize
		const slice = plaintext.subarray(start, Math.min(start + chunkSize, plaintext.length))
		const iv = new Uint8Array(IV_BYTES)
		globalThis.crypto.getRandomValues(iv)
		const sealed = await subtle.encrypt(
			{ name: "AES-GCM", iv: ab(iv), additionalData: ab(aadFor(fileId, i)) },
			key,
			ab(slice),
		)
		chunks.push({ index: i, iv: b64(iv), length: slice.length })
		blobs.push(new Uint8Array(sealed))
	}
	const base = {
		version: 1 as const,
		algo: FILE_ALGO,
		fileId,
		size: plaintext.length,
		chunkSize,
		chunkCount,
		chunks,
	}
	const manifestHash = await sha256b64(canonicalBytes(base))
	return { manifest: { ...base, manifestHash }, blobs }
}


// Streaming variant used for chat attachments. The plaintext is read slice by
// slice and each sealed chunk goes straight into a Blob batch, so neither the
// original file nor its ciphertext is ever held in the JS heap in full - a
// phone can send a gigabyte-sized video without the tab running out of memory.
const CIPHER_BATCH_BYTES = 8 * 1024 * 1024
const GCM_TAG_BYTES = 16
const MAX_CHUNKS = 2048
const MIN_CHUNK = DEFAULT_CHUNK
const MAX_CHUNK = 4 * 1024 * 1024

// The manifest carries one entry per chunk and travels inside the message, so
// chunk size grows with the file to keep that list short.
export function chunkSizeFor(size: number): number {
	if (size <= MIN_CHUNK * MAX_CHUNKS) return MIN_CHUNK
	let chunk = MIN_CHUNK
	while (chunk < MAX_CHUNK && Math.ceil(size / chunk) > MAX_CHUNKS) chunk *= 2
	return chunk
}

export async function encryptFileToBlob(
	rawKey: Uint8Array,
	source: Blob,
	fileId: string,
	onProgress?: (ratio: number) => void,
	chunkSize: number = chunkSizeFor(source.size),
): Promise<{ manifest: FileManifest; blob: Blob }> {
	const key = await importKey(rawKey)
	const size = source.size
	const chunkCount = Math.max(1, Math.ceil(size / chunkSize))
	const chunks: ChunkMeta[] = []
	const parts: Blob[] = []
	// Sealed chunks go into the Blob as raw buffers, with no extra heap copy.
	let batch: ArrayBuffer[] = []
	let batchBytes = 0
	for (let i = 0; i < chunkCount; i++) {
		const start = i * chunkSize
		const slice = await source.slice(start, Math.min(start + chunkSize, size)).arrayBuffer()
		const iv = new Uint8Array(IV_BYTES)
		globalThis.crypto.getRandomValues(iv)
		const sealed = await subtle.encrypt(
			{ name: "AES-GCM", iv: ab(iv), additionalData: ab(aadFor(fileId, i)) },
			key,
			slice,
		)
		chunks.push({ index: i, iv: b64(iv), length: slice.byteLength })
		batch.push(sealed)
		batchBytes += sealed.byteLength
		if (batchBytes >= CIPHER_BATCH_BYTES) {
			parts.push(new Blob(batch))
			batch = []
			batchBytes = 0
		}
		if (onProgress) onProgress((i + 1) / chunkCount)
	}
	if (batch.length > 0) parts.push(new Blob(batch))
	const base = {
		version: 1 as const,
		algo: FILE_ALGO,
		fileId,
		size,
		chunkSize,
		chunkCount,
		chunks,
	}
	const manifestHash = await sha256b64(canonicalBytes(base))
	return { manifest: { ...base, manifestHash }, blob: new Blob(parts) }
}

// Mirror of encryptFileToBlob for playback: the plaintext lands in a Blob in
// batches instead of one large heap buffer, so watching a big video costs about
// as much memory as sending it did.
export async function decryptFileToBlob(
	rawKey: Uint8Array,
	manifest: FileManifest,
	cipher: Uint8Array,
	type: string,
	onProgress?: (ratio: number) => void,
): Promise<Blob> {
	if (!(await verifyManifest(manifest))) throw new Error("manifest hash mismatch")
	const key = await importKey(rawKey)
	const parts: Blob[] = []
	let batch: ArrayBuffer[] = []
	let batchBytes = 0
	let offset = 0
	for (let i = 0; i < manifest.chunkCount; i++) {
		const meta = manifest.chunks[i]
		const sealedLength = meta.length + GCM_TAG_BYTES
		const sealed = cipher.subarray(offset, offset + sealedLength)
		if (sealed.length !== sealedLength) throw new Error("chunk " + i + " is truncated")
		offset += sealedLength
		const opened = await subtle.decrypt(
			{ name: "AES-GCM", iv: ab(unb64(meta.iv)), additionalData: ab(aadFor(manifest.fileId, i)) },
			key,
			ab(sealed),
		)
		if (opened.byteLength !== meta.length) throw new Error("chunk " + i + " length mismatch")
		batch.push(opened)
		batchBytes += opened.byteLength
		if (batchBytes >= CIPHER_BATCH_BYTES) {
			parts.push(new Blob(batch))
			batch = []
			batchBytes = 0
		}
		if (onProgress) onProgress((i + 1) / manifest.chunkCount)
	}
	if (batch.length > 0) parts.push(new Blob(batch))
	return new Blob(parts, { type })
}

export async function verifyManifest(manifest: FileManifest): Promise<boolean> {
	if (manifest.chunkCount !== manifest.chunks.length) return false
	const { manifestHash, ...base } = manifest
	const expected = await sha256b64(canonicalBytes(base))
	return expected === manifestHash
}

export async function decryptFile(
	rawKey: Uint8Array,
	manifest: FileManifest,
	blobs: Uint8Array[],
): Promise<Uint8Array> {
	if (!(await verifyManifest(manifest))) throw new Error("manifest hash mismatch")
	if (blobs.length !== manifest.chunkCount) throw new Error("chunk count mismatch")
	const key = await importKey(rawKey)
	const parts: Uint8Array[] = []
	let total = 0
	for (let i = 0; i < manifest.chunkCount; i++) {
		const meta = manifest.chunks[i]
		const opened = await subtle.decrypt(
			{ name: "AES-GCM", iv: ab(unb64(meta.iv)), additionalData: ab(aadFor(manifest.fileId, i)) },
			key,
			ab(blobs[i]),
		)
		const part = new Uint8Array(opened)
		if (part.length !== meta.length) throw new Error("chunk " + i + " length mismatch")
		parts.push(part)
		total += part.length
	}
	const merged = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		merged.set(part, offset)
		offset += part.length
	}
	return merged
}
