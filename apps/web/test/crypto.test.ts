import { test } from "node:test"
import assert from "node:assert/strict"
import { encryptText, decryptText, isEncrypted } from "../src/lib/crypto"

const CONV = "conv-abc-123"
const PASS = "correct horse battery staple"

test("round-trips plaintext through encrypt then decrypt", async () => {
	const plaintext = "Hello FrontierX \u2014 \u4e2d\u6587 multibyte test"
	const packed = await encryptText(CONV, PASS, plaintext)
	assert.ok(isEncrypted(packed), "ciphertext should carry the fx1: prefix")
	assert.notEqual(packed, plaintext)
	const restored = await decryptText(CONV, PASS, packed)
	assert.equal(restored, plaintext)
})

test("isEncrypted only matches the versioned prefix", () => {
	assert.equal(isEncrypted("fx1:anything"), true)
	assert.equal(isEncrypted("plain text"), false)
	assert.equal(isEncrypted(""), false)
})

test("decryptText passes through values without the prefix", async () => {
	const raw = "not encrypted"
	assert.equal(await decryptText(CONV, PASS, raw), raw)
})

test("a wrong passphrase fails authentication", async () => {
	const packed = await encryptText(CONV, PASS, "secret message")
	await assert.rejects(() => decryptText(CONV, "wrong passphrase", packed))
})

test("keys are bound to the conversation id", async () => {
	const packed = await encryptText(CONV, PASS, "secret message")
	await assert.rejects(() => decryptText("other-conversation", PASS, packed))
})

test("each message uses a fresh random iv", async () => {
	const a = await encryptText(CONV, PASS, "same message")
	const b = await encryptText(CONV, PASS, "same message")
	assert.notEqual(a, b)
	assert.equal(await decryptText(CONV, PASS, a), "same message")
	assert.equal(await decryptText(CONV, PASS, b), "same message")
})
