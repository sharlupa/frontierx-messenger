// Automatic key agreement for FrontierX conversations.
// Each user holds an ECDH P-256 identity key pair. The public key is published
// to the server; the private key never leaves the device. A random per
// conversation content key (CEK, AES-256-GCM) is wrapped for every member with
// ephemeral-static ECDH (ECIES): an ephemeral P-256 key, HKDF-SHA256 to an
// AES-GCM key-encryption key, then AES-GCM over the CEK. The server only ever
// stores wrapped key material and ciphertext, never plaintext keys.

const CURVE = "P-256"
const KEK_INFO = "frontierx:cek-wrap"

function b64encode(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
function b64decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export interface IdentityKeyPair {
  publicKey: string
  privateKey: string
}
export interface WrappedKey {
  ephemeralPublicKey: string
  iv: string
  ciphertext: string
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const pkcs8Private = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return { publicKey: b64encode(rawPublic), privateKey: b64encode(pkcs8Private) }
}

function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64decode(publicKey), { name: "ECDH", namedCurve: CURVE }, false, [])
}
function importPrivateKey(privateKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", b64decode(privateKey), { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"])
}

async function deriveKek(privateKey: CryptoKey, publicKey: CryptoKey, conversationId: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
  const salt = new TextEncoder().encode("frontierx:" + conversationId)
  const info = new TextEncoder().encode(KEK_INFO)
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, base, { name: "AES-GCM", length: 256 }, false, usage)
}

export function randomConversationKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}
export function importConversationKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

export async function wrapConversationKey(recipientPublicKey: string, conversationId: string, cek: Uint8Array): Promise<WrappedKey> {
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
  const recipient = await importPublicKey(recipientPublicKey)
  const kek = await deriveKek(ephemeral.privateKey, recipient, conversationId, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, new Uint8Array(cek)))
  const rawEph = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  return { ephemeralPublicKey: b64encode(rawEph), iv: b64encode(iv), ciphertext: b64encode(sealed) }
}

export async function unwrapConversationKey(privateKey: string, conversationId: string, wrapped: WrappedKey): Promise<Uint8Array> {
  const priv = await importPrivateKey(privateKey)
  const eph = await importPublicKey(wrapped.ephemeralPublicKey)
  const kek = await deriveKek(priv, eph, conversationId, ["decrypt"])
  const iv = b64decode(wrapped.iv)
  const sealed = b64decode(wrapped.ciphertext)
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, kek, sealed))
  return raw
}

// Password-protected identity backup. Signing in on a new device used to
// mint a brand new identity, which silently invalidated every wrapped
// conversation key and locked the whole history. The backup lets the same
// identity travel with the account while the server only sees ciphertext.
const BACKUP_ITERATIONS = 600000

export interface IdentityBackup {
  salt: string
  iv: string
  ciphertext: string
  iterations: number
  publicKey: string
}

// Recovers the public half from a stored private key so a device that still
// holds the identity can re-publish the matching public key.
export async function publicKeyFromPrivateKey(privateKey: string): Promise<string> {
  const priv = await crypto.subtle.importKey("pkcs8", b64decode(privateKey), { name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
  const jwk = await crypto.subtle.exportKey("jwk", priv)
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }
  const pub = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: CURVE }, true, [])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pub))
  return b64encode(raw)
}

async function passwordKey(password: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, usage)
}

export async function wrapIdentityWithPassword(identity: IdentityKeyPair, password: string): Promise<IdentityBackup> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await passwordKey(password, salt, BACKUP_ITERATIONS, ["encrypt"])
  const payload = new TextEncoder().encode(identity.privateKey)
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload))
  return {
    salt: b64encode(salt),
    iv: b64encode(iv),
    ciphertext: b64encode(sealed),
    iterations: BACKUP_ITERATIONS,
    publicKey: identity.publicKey,
  }
}

export async function unwrapIdentityWithPassword(backup: IdentityBackup, password: string): Promise<string> {
  const key = await passwordKey(password, b64decode(backup.salt), backup.iterations, ["decrypt"])
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(backup.iv) }, key, b64decode(backup.ciphertext))
  return new TextDecoder().decode(opened)
}
