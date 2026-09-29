import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeEncryptedBackup, encodeEncryptedBackup } from "../src/lib/fileBackupBundle"
import { decryptFile, encryptFile, randomFileKey } from "../src/lib/filecrypto"

test("temporary encrypted backup bundle preserves every encrypted chunk", async () => {
	const original = new TextEncoder().encode("FrontierX encrypted backup payload")
	const key = randomFileKey()
	const encrypted = await encryptFile(key, original, "file_bundle_test", 8)
	const encoded = encodeEncryptedBackup(encrypted)
	const restored = decodeEncryptedBackup(encoded, "file_bundle_test")
	assert.equal(restored.manifest.manifestHash, encrypted.manifest.manifestHash)
	assert.equal(restored.blobs.length, encrypted.blobs.length)
	const plaintext = await decryptFile(key, restored.manifest, restored.blobs)
	assert.deepEqual(Array.from(plaintext), Array.from(original))
})

test("temporary encrypted backup bundle rejects an unexpected file or trailing bytes", async () => {
	const key = randomFileKey()
	const encrypted = await encryptFile(key, new Uint8Array([1, 2, 3]), "file_bundle_guard")
	const encoded = encodeEncryptedBackup(encrypted)
	assert.throws(() => decodeEncryptedBackup(encoded, "another_file"), /manifest/)
	const withTrailing = new Uint8Array(encoded.length + 1)
	withTrailing.set(encoded)
	withTrailing[withTrailing.length - 1] = 7
	assert.throws(() => decodeEncryptedBackup(withTrailing, "file_bundle_guard"), /trailing/)
})
