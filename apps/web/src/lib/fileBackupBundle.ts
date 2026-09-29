import type { EncryptedFile, FileManifest } from "./filecrypto"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function readU32(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > bytes.length) throw new Error("truncated encrypted backup")
	return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
		throw new Error("encrypted backup part is too large")
	}
	new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function assertManifest(value: unknown, expectedFileId: string): asserts value is FileManifest {
	const manifest = asRecord(value)
	if (
		!manifest ||
		manifest.version !== 1 ||
		typeof manifest.algo !== "string" ||
		manifest.fileId !== expectedFileId ||
		typeof manifest.size !== "number" ||
		typeof manifest.chunkSize !== "number" ||
		typeof manifest.chunkCount !== "number" ||
		!Array.isArray(manifest.chunks) ||
		typeof manifest.manifestHash !== "string"
	) {
		throw new Error("invalid encrypted backup manifest")
	}
}

/**
 * Serializes encrypted chunks without exposing plaintext or file keys. The
 * server stores this opaque bundle as the temporary backup object.
 */
export function encodeEncryptedBackup(file: EncryptedFile): Uint8Array {
	if (file.blobs.length !== file.manifest.chunkCount) {
		throw new Error("encrypted backup chunk count does not match its manifest")
	}
	const manifestBytes = encoder.encode(JSON.stringify(file.manifest))
	const total = 4 + manifestBytes.length + file.blobs.reduce((sum, chunk) => sum + 4 + chunk.length, 0)
	if (total > 0xffffffff) throw new Error("encrypted backup is too large")

	const output = new Uint8Array(total)
	writeU32(output, 0, manifestBytes.length)
	output.set(manifestBytes, 4)
	let offset = 4 + manifestBytes.length
	for (const chunk of file.blobs) {
		writeU32(output, offset, chunk.length)
		offset += 4
		output.set(chunk, offset)
		offset += chunk.length
	}
	return output
}

/**
 * Parses an opaque temporary-backup bundle. Integrity and authenticity are
 * checked by decryptFile() before the recovered chunks become a local copy.
 */
export function decodeEncryptedBackup(bytes: Uint8Array, expectedFileId: string): EncryptedFile {
	const manifestLength = readU32(bytes, 0)
	const manifestStart = 4
	const manifestEnd = manifestStart + manifestLength
	if (manifestEnd > bytes.length) throw new Error("truncated encrypted backup manifest")

	let manifestValue: unknown
	try {
		manifestValue = JSON.parse(decoder.decode(bytes.subarray(manifestStart, manifestEnd)))
	} catch {
		throw new Error("invalid encrypted backup manifest")
	}
	assertManifest(manifestValue, expectedFileId)
	const manifest = manifestValue

	const blobs: Uint8Array[] = []
	let offset = manifestEnd
	for (let index = 0; index < manifest.chunkCount; index += 1) {
		const length = readU32(bytes, offset)
		offset += 4
		const end = offset + length
		if (end > bytes.length) throw new Error("truncated encrypted backup chunk")
		blobs.push(bytes.slice(offset, end))
		offset = end
	}
	if (offset !== bytes.length) throw new Error("unexpected trailing bytes in encrypted backup")
	return { manifest, blobs }
}
