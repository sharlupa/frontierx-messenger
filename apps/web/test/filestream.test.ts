import { test } from "node:test"
import assert from "node:assert/strict"
import { chunkSizeFor, decryptFile, encryptFileToBlob, randomFileKey, DEFAULT_CHUNK } from "../src/lib/filecrypto"
import { packFileFromBlob, parseMediaMessage, encodeMediaMessage, unpackFile } from "../src/lib/media"

const GCM_TAG = 16

// crypto.getRandomValues refuses more than 64 KiB per call.
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)))
  }
  return out
}

function splitSealed(cipher: Uint8Array, manifest: { chunks: Array<{ length: number }> }): Uint8Array[] {
  const out: Uint8Array[] = []
  let offset = 0
  for (const chunk of manifest.chunks) {
    const size = chunk.length + GCM_TAG
    out.push(cipher.subarray(offset, offset + size))
    offset += size
  }
  return out
}

test("streaming encryption produces a blob the normal decrypt can open", async () => {
  const plaintext = randomBytes(200_000)
  const key = randomFileKey()
  const seen: number[] = []
  const result = await encryptFileToBlob(key, new Blob([plaintext]), "file-stream", (ratio) => seen.push(ratio))
  assert.equal(result.manifest.size, plaintext.length)
  assert.equal(result.manifest.chunkCount, result.manifest.chunks.length)
  // Progress runs from the first chunk to exactly 1.
  assert.ok(seen.length === result.manifest.chunkCount)
  assert.equal(seen[seen.length - 1], 1)
  const cipher = new Uint8Array(await result.blob.arrayBuffer())
  const restored = await decryptFile(key, result.manifest, splitSealed(cipher, result.manifest))
  assert.deepEqual(Array.from(restored), Array.from(plaintext))
})

test("a blob-packed attachment round-trips through the message envelope", async () => {
  const plaintext = randomBytes(70_000)
  const packed = await packFileFromBlob("file-blob", "clip.mp4", "video/mp4", new Blob([plaintext]), {
    duration: 12.5,
    width: 640,
    height: 360,
  })
  assert.equal(packed.envelope.mime, "video/mp4")
  assert.equal(packed.envelope.size, plaintext.length)
  assert.equal(packed.envelope.duration, 12.5)
  const parsed = parseMediaMessage(encodeMediaMessage(packed.envelope))
  assert.ok(parsed)
  const cipher = new Uint8Array(await packed.blob.arrayBuffer())
  const restored = await unpackFile(parsed, cipher)
  assert.deepEqual(Array.from(restored), Array.from(plaintext))
})

test("chunk size grows with the file so the manifest stays small", () => {
  assert.equal(chunkSizeFor(1_000_000), DEFAULT_CHUNK)
  const big = chunkSizeFor(2 * 1024 * 1024 * 1024)
  assert.ok(big > DEFAULT_CHUNK)
  assert.ok(Math.ceil(2 * 1024 * 1024 * 1024 / big) <= 8192)
  // Every size keeps the chunk count bounded enough for the manifest to fit in
  // a message body.
  for (const size of [5_000_000, 50_000_000, 500_000_000, 1024 * 1024 * 1024]) {
    assert.ok(Math.ceil(size / chunkSizeFor(size)) <= 8192)
  }
})
