import { test } from "node:test"
import assert from "node:assert/strict"
import { packImage, unpackImage, encodeMediaMessage, parseMediaMessage, MEDIA_PREFIX } from "../src/lib/media"

test("media roundtrip pack encode parse unpack", async () => {
  const plaintext = crypto.getRandomValues(new Uint8Array(5000))
  const packed = await packImage("file-1", "photo.png", "image/png", plaintext)
  assert.equal(packed.envelope.kind, "image")
  assert.equal(packed.envelope.fileId, "file-1")
  assert.equal(packed.envelope.mime, "image/png")
  assert.equal(packed.envelope.size, plaintext.length)
  assert.ok(packed.cipher.length >= plaintext.length)
  const text = encodeMediaMessage(packed.envelope)
  assert.ok(text.startsWith(MEDIA_PREFIX))
  const parsed = parseMediaMessage(text)
  assert.ok(parsed)
  const restored = await unpackImage(parsed, packed.cipher)
  assert.equal(restored.length, plaintext.length)
  assert.deepEqual(Array.from(restored), Array.from(plaintext))
})

test("parseMediaMessage rejects non-media text", () => {
  assert.equal(parseMediaMessage("hello"), null)
  assert.equal(parseMediaMessage(null), null)
  assert.equal(parseMediaMessage(""), null)
})

test("media cipher fails to decrypt with wrong key", async () => {
  const plaintext = crypto.getRandomValues(new Uint8Array(64))
  const good = await packImage("file-x", "a.bin", "image/png", plaintext)
  const other = await packImage("file-x", "a.bin", "image/png", plaintext)
  const swapped = { ...good.envelope, key: other.envelope.key }
  await assert.rejects(async () => { await unpackImage(swapped, good.cipher) })
})
