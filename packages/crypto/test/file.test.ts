import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import {
	encryptFile,
	decryptFile,
	verifyManifest,
	randomFileKey,
	type FileManifest,
} from "../src/file"

const FILE_ID = "file-abc-123"

test("encrypts across multiple chunks and decrypts back to the exact bytes", () => {
	const key = randomFileKey()
	const plaintext = randomBytes(150000)
	const enc = encryptFile(key, plaintext, FILE_ID)
	assert.equal(enc.manifest.chunkCount, 3)
	assert.equal(enc.manifest.size, plaintext.length)
	assert.equal(enc.blobs.length, 3)
	assert.ok(verifyManifest(enc.manifest))
	const decrypted = decryptFile(key, enc.manifest, enc.blobs)
	assert.ok(decrypted.equals(plaintext))
})

test("ciphertext never contains the plaintext bytes", () => {
	const key = randomFileKey()
	const plaintext = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(4000), "utf8")
	const enc = encryptFile(key, plaintext, FILE_ID)
	const joined = Buffer.concat(enc.blobs)
	assert.equal(joined.equals(plaintext), false)
	assert.equal(joined.includes(Buffer.from("quick brown fox", "utf8")), false)
})

test("handles a single small chunk and an empty payload", () => {
	const key = randomFileKey()
	const small = Buffer.from("hi", "utf8")
	const encSmall = encryptFile(key, small, FILE_ID)
	assert.equal(encSmall.manifest.chunkCount, 1)
	assert.ok(decryptFile(key, encSmall.manifest, encSmall.blobs).equals(small))

	const empty = Buffer.alloc(0)
	const encEmpty = encryptFile(key, empty, FILE_ID)
	assert.equal(encEmpty.manifest.chunkCount, 1)
	assert.equal(encEmpty.manifest.size, 0)
	assert.ok(decryptFile(key, encEmpty.manifest, encEmpty.blobs).equals(empty))
})

test("a wrong key fails authenticated decryption", () => {
	const key = randomFileKey()
	const other = randomFileKey()
	const enc = encryptFile(key, randomBytes(1000), FILE_ID)
	assert.throws(() => decryptFile(other, enc.manifest, enc.blobs))
})

test("tampering with a ciphertext chunk is detected", () => {
	const key = randomFileKey()
	const enc = encryptFile(key, randomBytes(1000), FILE_ID, 512)
	enc.blobs[0][0] ^= 0xff
	assert.throws(() => decryptFile(key, enc.manifest, enc.blobs))
})

test("reordering chunks fails the position binding", () => {
	const key = randomFileKey()
	const enc = encryptFile(key, randomBytes(1024), FILE_ID, 512)
	assert.equal(enc.manifest.chunkCount, 2)
	const swapped = [enc.blobs[1], enc.blobs[0]]
	assert.throws(() => decryptFile(key, enc.manifest, swapped))
})

test("verifyManifest rejects a modified manifest and decrypt refuses it", () => {
	const key = randomFileKey()
	const enc = encryptFile(key, randomBytes(1000), FILE_ID)
	const tampered: FileManifest = { ...enc.manifest, size: enc.manifest.size + 1 }
	assert.equal(verifyManifest(tampered), false)
	assert.throws(() => decryptFile(key, tampered, enc.blobs), /manifest hash mismatch/)
})

test("the file id is bound into the manifest", () => {
	const key = randomFileKey()
	const enc = encryptFile(key, randomBytes(1000), FILE_ID)
	const wrongId: FileManifest = { ...enc.manifest, fileId: "file-xyz-999" }
	assert.equal(verifyManifest(wrongId), false)
	assert.throws(() => decryptFile(key, wrongId, enc.blobs))
})
