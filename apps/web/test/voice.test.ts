import { test } from "node:test"
import assert from "node:assert/strict"
import { packFile, encodeMediaMessage, parseMediaMessage, unpackFile } from "../src/lib/media"
import { formatDuration, resampleWaveform, voiceExtension, WAVEFORM_BARS } from "../src/lib/voice"

test("voice envelope carries duration and waveform through a roundtrip", async () => {
  const plaintext = crypto.getRandomValues(new Uint8Array(2048))
  const waveform = resampleWaveform([4, 40, 90, 12, 60, 75])
  const packed = await packFile("voice-1", "voice-1.webm", "audio/webm;codecs=opus", plaintext, {
    kind: "voice",
    duration: 3.4,
    waveform,
  })
  assert.equal(packed.envelope.kind, "voice")
  assert.equal(packed.envelope.duration, 3.4)
  assert.deepEqual(packed.envelope.waveform, waveform)
  const parsed = parseMediaMessage(encodeMediaMessage(packed.envelope))
  assert.ok(parsed)
  assert.equal(parsed.kind, "voice")
  assert.equal(parsed.duration, 3.4)
  const restored = await unpackFile(parsed, packed.cipher)
  assert.deepEqual(Array.from(restored), Array.from(plaintext))
})

test("extra envelope fields cannot break decryption", async () => {
  const plaintext = crypto.getRandomValues(new Uint8Array(512))
  const packed = await packFile("voice-2", "voice-2.webm", "audio/webm", plaintext, {
    fileId: "not-the-real-id",
    key: "bm90LWEta2V5",
    manifest: { chunks: [] } as any,
  })
  assert.equal(packed.envelope.fileId, "voice-2")
  const restored = await unpackFile(packed.envelope, packed.cipher)
  assert.deepEqual(Array.from(restored), Array.from(plaintext))
})

test("waveform resampling gives a fixed number of bounded bars", () => {
  const dense = resampleWaveform(new Array(500).fill(0).map((_unused, index) => index % 100))
  assert.equal(dense.length, WAVEFORM_BARS)
  for (const bar of dense) {
    assert.ok(bar >= 6 && bar <= 100)
  }
  const silent = resampleWaveform([0, 0, 0])
  assert.equal(silent.length, WAVEFORM_BARS)
  assert.ok(silent.every((bar) => bar === 6))
  const empty = resampleWaveform([])
  assert.equal(empty.length, WAVEFORM_BARS)
})

test("duration and extension formatting", () => {
  assert.equal(formatDuration(0), "0:00")
  assert.equal(formatDuration(9.4), "0:09")
  assert.equal(formatDuration(75), "1:15")
  assert.equal(voiceExtension("audio/webm;codecs=opus"), "webm")
  assert.equal(voiceExtension("audio/ogg;codecs=opus"), "ogg")
  assert.equal(voiceExtension("audio/mp4"), "m4a")
})
