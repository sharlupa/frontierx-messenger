import { test } from "node:test"
import assert from "node:assert/strict"
import { encryptFile, decryptFile, verifyManifest, randomFileKey } from "../src/lib/filecrypto"

const FILE_ID = "file-web-1"

function rand(n: number): Uint8Array {
	const a = new Uint8Array(n)
	for (let off = 0; off < n; off += 65536) {
		const part = new Uint8Array(Math.min(65536, n - off))
		globalThis.crypto.getRandomValues(part)
		a.set(part, off)
	}
	return a
}

test("multi-chunk round-trip returns exact bytes", async () => {
	const key = randomFileKey()
	const data = rand(150000)
	const enc = await encryptFile(key, data, FILE_ID)
	assert.equal(enc.manifest.chunkCount, 3)
	const dec = await decryptFile(key, enc.manifest, enc.blobs)
	assert.deepEqual(dec, data)
})

test("ciphertext differs from plaintext", async () => {
	const key = randomFileKey()
	const data = rand(1000)
	const enc = await encryptFile(key, data, FILE_ID)
	assert.notDeepEqual(enc.blobs[0].subarray(0, data.length), data)
})

test("empty and tiny payloads use one chunk", async () => {
	const key = randomFileKey()
	const empty = await encryptFile(key, new Uint8Array(0), FILE_ID)
	assert.equal(empty.manifest.chunkCount, 1)
	assert.deepEqual(await decryptFile(key, empty.manifest, empty.blobs), new Uint8Array(0))
	const hi = new TextEncoder().encode("hi")
	const encHi = await encryptFile(key, hi, FILE_ID)
	assert.equal(encHi.manifest.chunkCount, 1)
	assert.deepEqual(await decryptFile(key, encHi.manifest, encHi.blobs), hi)
})

test("wrong key is rejected", async () => {
	const key = randomFileKey()
	const other = randomFileKey()
	const enc = await encryptFile(key, rand(500), FILE_ID)
	await assert.rejects(() => decryptFile(other, enc.manifest, enc.blobs))
})

test("a tampered chunk is rejected", async () => {
	const key = randomFileKey()
	const enc = await encryptFile(key, rand(600), FILE_ID, 512)
	enc.blobs[0][0] ^= 0xff
	await assert.rejects(() => decryptFile(key, enc.manifest, enc.blobs))
})

test("reordered chunks are rejected", async () => {
	const key = randomFileKey()
	const enc = await encryptFile(key, rand(1024), FILE_ID, 512)
	assert.equal(enc.manifest.chunkCount, 2)
	const swapped = [enc.blobs[1], enc.blobs[0]]
	await assert.rejects(() => decryptFile(key, enc.manifest, swapped))
})

test("a tampered manifest fails verification", async () => {
	const key = randomFileKey()
	const enc = await encryptFile(key, rand(500), FILE_ID)
	const bad = { ...enc.manifest, size: enc.manifest.size + 1 }
	assert.equal(await verifyManifest(bad), false)
	await assert.rejects(() => decryptFile(key, bad, enc.blobs), /manifest hash mismatch/)
})

test("wrong fileId fails verification", async () => {
	const key = randomFileKey()
	const enc = await encryptFile(key, rand(500), FILE_ID)
	const wrong = { ...enc.manifest, fileId: "file-web-2" }
	assert.equal(await verifyManifest(wrong), false)
})
