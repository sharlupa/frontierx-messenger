import { randomBytes } from "node:crypto"

// Crockford base32; time-sortable ULID-style identifiers.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const ENCODING_LEN = ENCODING.length
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(now: number, len: number): string {
  let str = ""
  let t = now
  for (let i = len - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN
    str = ENCODING[mod] + str
    t = (t - mod) / ENCODING_LEN
  }
  return str
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len)
  let str = ""
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % ENCODING_LEN]
  }
  return str
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN)
}

export function newId(prefix?: string): string {
  const id = ulid()
  return prefix ? `${prefix}_${id}` : id
}
