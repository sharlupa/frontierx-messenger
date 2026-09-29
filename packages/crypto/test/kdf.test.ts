import test from "node:test"
import assert from "node:assert/strict"
import { hashPassword, verifyPassword, deriveKey } from "../src/kdf"

test("hashPassword produces the labelled scrypt format", () => {
  const parts = hashPassword("correct horse battery staple").split("$")
  assert.equal(parts[0], "scrypt")
  assert.equal(parts.length, 6)
})

test("verifyPassword accepts the right password and rejects wrong ones", () => {
  const h = hashPassword("s3cret-passphrase")
  assert.equal(verifyPassword("s3cret-passphrase", h), true)
  assert.equal(verifyPassword("not-it", h), false)
})

test("same password hashes to different salts (non-deterministic)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"))
})

test("deriveKey is deterministic per info and 32 bytes by default", () => {
  const ikm = Buffer.from("input key material")
  const a = deriveKey(ikm, "frontierx/file")
  const b = deriveKey(ikm, "frontierx/file")
  const c = deriveKey(ikm, "frontierx/other")
  assert.equal(a.length, 32)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
})

test("deriveKey varies with salt and honors a custom length", () => {
  const ikm = Buffer.from("input key material")
  const s1 = deriveKey(ikm, "frontierx/file", 32, Buffer.from("salt-1"))
  const s2 = deriveKey(ikm, "frontierx/file", 32, Buffer.from("salt-2"))
  assert.notDeepEqual(s1, s2)
  assert.equal(deriveKey(ikm, "frontierx/file", 64).length, 64)
})
