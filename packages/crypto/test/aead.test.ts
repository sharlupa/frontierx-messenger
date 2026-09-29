import test from "node:test"
import assert from "node:assert/strict"
import { seal, open, randomKey, randomNonce, KEY_BYTES, NONCE_BYTES, TAG_BYTES } from "../src/aead"

test("seal/open roundtrip returns the original plaintext", () => {
  const key = randomKey()
  const msg = Buffer.from("frontierx secret payload", "utf8")
  const sealed = seal(key, msg)
  assert.deepEqual(open(key, sealed), msg)
})

test("key/nonce/tag sizes match the AEAD contract", () => {
  assert.equal(KEY_BYTES, 32)
  assert.equal(NONCE_BYTES, 12)
  assert.equal(TAG_BYTES, 16)
  assert.equal(randomKey().length, 32)
  assert.equal(randomNonce().length, 12)
})

test("a caller-supplied nonce is echoed in the sealed output", () => {
  const key = randomKey()
  const nonce = randomNonce()
  const msg = Buffer.from("with explicit nonce")
  const sealed = seal(key, msg, undefined, nonce)
  assert.deepEqual(sealed.nonce, nonce)
  assert.deepEqual(open(key, sealed), msg)
})

test("tampered ciphertext fails authentication", () => {
  const key = randomKey()
  const sealed = seal(key, Buffer.from("do not modify"))
  sealed.ciphertext[0] ^= 0x01
  assert.throws(() => open(key, sealed))
})

test("associated data must match to open", () => {
  const key = randomKey()
  const aad = Buffer.from("file:7", "utf8")
  const sealed = seal(key, Buffer.from("bound"), aad)
  assert.throws(() => open(key, sealed, Buffer.from("file:8")))
  assert.equal(open(key, sealed, aad).toString("utf8"), "bound")
})

test("wrong key cannot decrypt", () => {
  const sealed = seal(randomKey(), Buffer.from("x"))
  assert.throws(() => open(randomKey(), sealed))
})
