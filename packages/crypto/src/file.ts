import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { AEAD_ALG, KEY_BYTES, NONCE_BYTES, TAG_BYTES, setAad } from "./aead.js"

// Local-first file encryption: compress (caller) -> chunk -> encrypt per chunk.
// Each chunk uses a fresh nonce and binds its position via AAD, so reordering
// or substituting chunks fails authentication. A manifest hash binds the whole
// file so tampering with the chunk list is detected before any decryption.

const DEFAULT_CHUNK = 64 * 1024

export interface ChunkMeta {
  index: number
  nonce: string // base64
  tag: string // base64
  length: number // ciphertext byte length
}

export interface FileManifest {
  version: 1
  algo: typeof AEAD_ALG
  fileId: string
  size: number // plaintext total size
  chunkSize: number
  chunkCount: number
  chunks: ChunkMeta[]
  manifestHash: string // hex sha256 over canonical chunk metadata
}

export interface EncryptedFile {
  manifest: FileManifest
  blobs: Buffer[] // ciphertext per chunk, aligned with manifest.chunks
}

export function randomFileKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

function aadFor(fileId: string, index: number): Buffer {
  return Buffer.from(`${fileId}:${index}`, "utf8")
}

function computeManifestHash(m: Omit<FileManifest, "manifestHash">): string {
  const h = createHash("sha256")
  h.update(`${m.version}|${m.algo}|${m.fileId}|${m.size}|${m.chunkSize}|${m.chunkCount}`)
  for (const c of m.chunks) {
    h.update(`|${c.index}:${c.nonce}:${c.tag}:${c.length}`)
  }
  return h.digest("hex")
}

export function encryptFile(
  dataKey: Buffer,
  plaintext: Buffer,
  fileId: string,
  chunkSize: number = DEFAULT_CHUNK,
): EncryptedFile {
  if (dataKey.length !== KEY_BYTES) throw new Error(`dataKey must be ${KEY_BYTES} bytes`)
  if (chunkSize <= 0) throw new Error("chunkSize must be positive")
  const chunks: ChunkMeta[] = []
  const blobs: Buffer[] = []
  const chunkCount = Math.max(1, Math.ceil(plaintext.length / chunkSize))
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const slice = plaintext.subarray(start, Math.min(start + chunkSize, plaintext.length))
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(AEAD_ALG, dataKey, nonce, { authTagLength: TAG_BYTES })
    setAad(cipher, aadFor(fileId, i))
    const ct = Buffer.concat([cipher.update(slice), cipher.final()])
    const tag = cipher.getAuthTag()
    chunks.push({
      index: i,
      nonce: nonce.toString("base64"),
      tag: tag.toString("base64"),
      length: ct.length,
    })
    blobs.push(ct)
  }
  const base = {
    version: 1 as const,
    algo: AEAD_ALG,
    fileId,
    size: plaintext.length,
    chunkSize,
    chunkCount,
    chunks,
  }
  return { manifest: { ...base, manifestHash: computeManifestHash(base) }, blobs }
}

export function verifyManifest(manifest: FileManifest): boolean {
  const { manifestHash, ...rest } = manifest
  return computeManifestHash(rest) === manifestHash
}

export function decryptFile(
  dataKey: Buffer,
  manifest: FileManifest,
  blobs: Buffer[],
): Buffer {
  if (!verifyManifest(manifest)) throw new Error("manifest hash mismatch")
  if (blobs.length !== manifest.chunkCount) throw new Error("chunk count mismatch")
  const out: Buffer[] = []
  for (let i = 0; i < manifest.chunkCount; i++) {
    const meta = manifest.chunks[i]
    const blob = blobs[i]
    if (meta.length !== blob.length) throw new Error(`chunk ${i} length mismatch`)
    const decipher = createDecipheriv(AEAD_ALG, dataKey, Buffer.from(meta.nonce, "base64"), {
      authTagLength: TAG_BYTES,
    })
    setAad(decipher, aadFor(manifest.fileId, i))
    decipher.setAuthTag(Buffer.from(meta.tag, "base64"))
    out.push(Buffer.concat([decipher.update(blob), decipher.final()]))
  }
  return Buffer.concat(out)
}
