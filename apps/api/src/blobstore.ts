import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

// Encrypted-at-rest blob storage. The server only stores ciphertext produced
// on the client (the per-file data key never leaves the device), so this also
// serves as the encrypted temp-server backup for media. Bytes live on local
// disk under FILE_BLOB_DIR; swapping to S3 or MinIO later only replaces these
// functions.

const BASE = process.env.FILE_BLOB_DIR ?? "frontierx-blobs"
const UND = String.fromCharCode(95)

function ensureDir(): string {
  fs.mkdirSync(BASE, { recursive: true })
  return BASE
}

function safeId(id: string): string {
  let out = ""
  for (const ch of id) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === UND ||
      ch === "-"
    out += ok ? ch : UND
  }
  return out.length > 0 ? out : "blob"
}

function blobPath(id: string): string {
  return path.join(ensureDir(), safeId(id) + ".bin")
}

export class BlobTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super("blob exceeds the configured byte limit")
    this.name = "BlobTooLargeError"
  }
}

async function writeAll(handle: fs.promises.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset)
    if (result.bytesWritten <= 0) throw new Error("could not write encrypted blob bytes")
    offset += result.bytesWritten
  }
}

// Stream uploads into a private temporary file and atomically replace the
// previous blob only after a complete, in-limit request arrives. This avoids
// buffering an entire encrypted upload in API memory and preserves a known-good
// backup if an interrupted or oversized retry fails.
export async function saveBlobFromStream(
  id: string,
  chunks: AsyncIterable<Uint8Array>,
  limitBytes: number,
): Promise<number> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new RangeError("invalid blob byte limit")
  const target = blobPath(id)
  const temp = path.join(path.dirname(target), "." + path.basename(target) + "." + randomUUID() + ".tmp")
  let handle: fs.promises.FileHandle | null = null
  let total = 0
  try {
    handle = await fs.promises.open(temp, "wx", 0o600)
    for await (const value of chunks) {
      const bytes = Buffer.from(value)
      if (bytes.length > limitBytes - total) throw new BlobTooLargeError(limitBytes)
      await writeAll(handle, bytes)
      total += bytes.length
    }
    await handle.close()
    handle = null
    await fs.promises.rename(temp, target)
    return total
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export function saveBlob(id: string, bytes: Uint8Array): void {
  fs.writeFileSync(blobPath(id), bytes)
}

export function readBlob(id: string): Buffer | null {
  const target = blobPath(id)
  if (!fs.existsSync(target)) return null
  return fs.readFileSync(target)
}

export function hasBlob(id: string): boolean {
  return fs.existsSync(blobPath(id))
}

export function blobByteLength(id: string): number {
  const target = blobPath(id)
  return fs.existsSync(target) ? fs.statSync(target).size : 0
}

// Space left for unprivileged writers on the blob disk.
export function freeDiskBytes(): number {
  const stats = fs.statfsSync(ensureDir())
  return Number(stats.bavail) * Number(stats.bsize)
}

export function deleteBlob(id: string): void {
  const target = blobPath(id)
  if (fs.existsSync(target)) fs.rmSync(target)
}
