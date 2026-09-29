import { hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

// Password hashing with scrypt (memory-hard, built in). Argon2id is the M4
// target once a vetted binding is added; the format string is versioned so we
// can migrate stored hashes without breaking existing accounts.
const SCRYPT_N = 1 << 15 // 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
const SALT_BYTES = 16
const MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const dk = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  })
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    dk.toString("base64"),
  ].join("$")
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4], "base64")
  const expected = Buffer.from(parts[5], "base64")
  const dk = scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  })
  return dk.length === expected.length && timingSafeEqual(dk, expected)
}

// HKDF-SHA256 for deriving purpose-specific keys from a master secret.
export function deriveKey(
  master: Buffer,
  info: string,
  length = 32,
  salt: Buffer = Buffer.alloc(0),
): Buffer {
  const derived = hkdfSync("sha256", master, salt, Buffer.from(info, "utf8"), length)
  return Buffer.from(derived)
}
