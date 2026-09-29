import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

// Authenticated encryption with associated data.
// ChaCha20-Poly1305 (IETF): 32-byte key, 12-byte nonce, 16-byte tag.
export const AEAD_ALG = "chacha20-poly1305" as const
export const KEY_BYTES = 32
export const NONCE_BYTES = 12
export const TAG_BYTES = 16

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function randomNonce(): Buffer {
  return randomBytes(NONCE_BYTES)
}

export interface Sealed {
  nonce: Buffer
  ciphertext: Buffer
  tag: Buffer
}

// Node types classify chacha20-poly1305 as a CCM cipher, whose setAAD signature
// demands a plaintextLength option. At runtime this cipher is GCM-shaped and
// accepts associated data with a single argument, so we narrow the call here
// instead of passing an option the cipher does not use.
type AadSink = { setAAD(aad: Buffer): unknown }

export function setAad(target: unknown, aad: Buffer): void {
  (target as AadSink).setAAD(aad)
}

export function seal(
  key: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
  nonce: Buffer = randomNonce(),
): Sealed {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`)
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes`)
  const cipher = createCipheriv(AEAD_ALG, key, nonce, { authTagLength: TAG_BYTES })
  if (aad) setAad(cipher, aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { nonce, ciphertext, tag }
}

export function open(key: Buffer, sealed: Sealed, aad?: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`)
  const decipher = createDecipheriv(AEAD_ALG, key, sealed.nonce, {
    authTagLength: TAG_BYTES,
  })
  if (aad) setAad(decipher, aad)
  decipher.setAuthTag(sealed.tag)
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()])
}
