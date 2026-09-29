// Cryptography of key system v2. Everything here is WebCrypto: no key ever
// leaves this module in the clear except to the caller that asked for it.
//
//   account key (AK)   32 random bytes, the root of an account's keys
//   slots              the AK sealed with the password (PBKDF2), a recovery
//                      key (HKDF) or for the identity key (ECDH P-256)
//   vault items        identity keys and conversation keys sealed with the AK
//   shares             a conversation key wrapped for one member's identity
//   messages (fx2)     AES-256-GCM under a named conversation key, bound to
//                      the conversation and the key id
//
// Additional data binds every sealed item to the account (and conversation,
// and key id) it belongs to, so the server cannot move sealed blobs around.

export type Bytes = Uint8Array<ArrayBuffer>

export const PBKDF2_ITERATIONS = 600000
const CURVE = "P-256"
const enc = new TextEncoder()
const dec = new TextDecoder()

export function toB64(bytes: Uint8Array): string {
	let binary = ""
	for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
	return btoa(binary)
}

export function fromB64(value: string): Bytes {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
	const padded = normalized + "===".slice((normalized.length + 3) % 4)
	const binary = atob(padded)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
	return out
}

export function toB64Url(bytes: Uint8Array): string {
	return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function randomBytes(length: number): Bytes {
	return crypto.getRandomValues(new Uint8Array(length))
}

function bytes(value: Uint8Array): Bytes {
	return new Uint8Array(value)
}

function concat(...parts: Uint8Array[]): Bytes {
	let total = 0
	for (const part of parts) total += part.length
	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
	return diff === 0
}

export interface Sealed {
	iv: string
	ciphertext: string
}

export async function aesKey(raw: Uint8Array, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", bytes(raw), { name: "AES-GCM" }, false, usages)
}

export async function sealWith(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Sealed> {
	const iv = randomBytes(12)
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, bytes(plaintext)))
	return { iv: toB64(iv), ciphertext: toB64(sealed) }
}

export async function openWith(key: CryptoKey, sealed: Sealed, aad: string): Promise<Bytes> {
	const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv), additionalData: enc.encode(aad) }, key, fromB64(sealed.ciphertext))
	return new Uint8Array(opened)
}

// --- account key -----------------------------------------------------------

export function newAccountKey(): Bytes {
	return randomBytes(32)
}

const akAad = (userId: string, purpose: string) => "fx:ak:" + purpose + ":v1:" + userId

// A value only the right account key opens: lets a device check that the key
// it holds (or just unwrapped) is this account's current one.
export async function accountKeyCheck(ak: Uint8Array, userId: string): Promise<Sealed> {
	return sealWith(await aesKey(ak), enc.encode("frontierx-account-key"), akAad(userId, "check"))
}

export async function verifyAccountKey(ak: Uint8Array, userId: string, check: Sealed | null | undefined): Promise<boolean> {
	if (!check) return false
	try {
		const opened = await openWith(await aesKey(ak), check, akAad(userId, "check"))
		return dec.decode(opened) === "frontierx-account-key"
	} catch {
		return false
	}
}

export type SlotKind = "password" | "recovery" | "identity"

export interface SlotPayload {
	kind: SlotKind
	kdf: Record<string, unknown>
	iv: string
	ciphertext: string
	label?: string | null
}

export interface StoredSlot extends SlotPayload {
	id: string
	stale: boolean
	createdAt: string
	updatedAt: string
}

async function passwordWrappingKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"])
	return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

export async function sealAkWithPassword(ak: Uint8Array, password: string, userId: string, iterations = PBKDF2_ITERATIONS): Promise<SlotPayload> {
	const salt = randomBytes(16)
	const key = await passwordWrappingKey(password, salt, iterations)
	const sealed = await sealWith(key, ak, akAad(userId, "password"))
	return { kind: "password", kdf: { alg: "PBKDF2-SHA256", iterations, salt: toB64(salt) }, ...sealed }
}

export async function openAkWithPassword(slot: SlotPayload, password: string, userId: string): Promise<Bytes> {
	const iterations = Number(slot.kdf.iterations)
	const salt = fromB64(String(slot.kdf.salt ?? ""))
	if (!Number.isFinite(iterations) || iterations < 100000) throw new Error("slot parameters are invalid")
	return openWith(await passwordWrappingKey(password, salt, iterations), slot, akAad(userId, "password"))
}

// --- recovery key ------------------------------------------------------------
// 20 random bytes in Crockford base32 plus a 4-character checksum, shown as
// nine groups of four: typos are caught before anything is tried.

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function base32(data: Uint8Array): string {
	let out = ""
	let buffer = 0
	let bits = 0
	for (const byte of data) {
		buffer = (buffer << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += B32[(buffer >> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += B32[(buffer << (5 - bits)) & 31]
	return out
}

function unbase32(text: string): Bytes | null {
	const out: number[] = []
	let buffer = 0
	let bits = 0
	for (const ch of text) {
		const value = B32.indexOf(ch)
		if (value < 0) return null
		buffer = (buffer << 5) | value
		bits += 5
		if (bits >= 8) {
			out.push((buffer >> (bits - 8)) & 255)
			bits -= 8
		}
	}
	return new Uint8Array(out)
}

async function recoveryChecksum(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(enc.encode("fx-recovery"), data)))
	return base32(digest.subarray(0, 3)).slice(0, 4)
}

export async function newRecoveryKey(): Promise<{ code: string; bytes: Bytes }> {
	const data = randomBytes(20)
	const text = base32(data) + (await recoveryChecksum(data))
	const groups = text.match(/.{1,4}/g) ?? []
	return { code: groups.join("-"), bytes: data }
}

// Accepts any spacing, dashes and case; O/I/L read as 0/1/1.
export async function parseRecoveryKey(input: string): Promise<Bytes | null> {
	const text = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
	if (text.length !== 36) return null
	const data = unbase32(text.slice(0, 32))
	if (!data || data.length !== 20) return null
	return (await recoveryChecksum(data)) === text.slice(32) ? data : null
}

async function hkdfKey(ikm: Uint8Array, salt: Uint8Array, info: string, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", bytes(ikm), "HKDF", false, ["deriveKey"])
	return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: enc.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, usages)
}

export async function sealAkWithRecovery(ak: Uint8Array, recovery: Uint8Array, userId: string): Promise<SlotPayload> {
	const salt = randomBytes(16)
	const key = await hkdfKey(recovery, salt, "fx:recovery:v1")
	const sealed = await sealWith(key, ak, akAad(userId, "recovery"))
	return { kind: "recovery", kdf: { alg: "HKDF-SHA256", salt: toB64(salt) }, ...sealed }
}

export async function openAkWithRecovery(slot: SlotPayload, recovery: Uint8Array, userId: string): Promise<Bytes> {
	const key = await hkdfKey(recovery, fromB64(String(slot.kdf.salt ?? "")), "fx:recovery:v1")
	return openWith(key, slot, akAad(userId, "recovery"))
}

// --- identity keys ---------------------------------------------------------------

export interface Identity {
	publicKey: string
	privateKey: string
}

export async function generateIdentity(): Promise<Identity> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
	const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
	return { publicKey: toB64(rawPublic), privateKey: toB64(pkcs8) }
}

export async function publicKeyOf(privateKey: string): Promise<string> {
	const priv = await crypto.subtle.importKey("pkcs8", fromB64(privateKey), { name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
	const jwk = await crypto.subtle.exportKey("jwk", priv)
	const pub = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, { name: "ECDH", namedCurve: CURVE }, true, [])
	return toB64(new Uint8Array(await crypto.subtle.exportKey("raw", pub)))
}

export async function fingerprint(publicKey: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(publicKey)))
	let hex = ""
	for (const byte of digest.subarray(0, 16)) hex += byte.toString(16).padStart(2, "0")
	return hex
}

// Safety number shown to people who want to check each other's keys: the same
// digits appear on both sides for the same pair of keys.
export async function safetyNumber(a: string, b: string): Promise<string> {
	const [first, second] = [a, b].sort()
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", concat(enc.encode("fx-safety"), fromB64(first), fromB64(second))))
	const groups: string[] = []
	for (let i = 0; i < 12; i += 1) {
		const value = ((digest[i * 3] << 16) | (digest[i * 3 + 1] << 8) | digest[i * 3 + 2]) % 100000
		groups.push(String(value).padStart(5, "0"))
	}
	return groups.join(" ")
}

function importPublic(publicKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", fromB64(publicKey), { name: "ECDH", namedCurve: CURVE }, false, [])
}

function importPrivate(privateKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("pkcs8", fromB64(privateKey), { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"])
}

// ECIES: an ephemeral P-256 key agrees a secret with the recipient's key; HKDF
// turns it into an AES-GCM key for one sealed payload.
async function eciesSeal(recipientPublicKey: string, plaintext: Uint8Array, salt: string, info: string, aad: string): Promise<{ ephemeralPublicKey: string } & Sealed> {
	const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublic(recipientPublicKey) }, ephemeral.privateKey, 256))
	const key = await hkdfKey(shared, enc.encode(salt), info, ["encrypt"])
	const sealed = await sealWith(key, plaintext, aad)
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
	return { ephemeralPublicKey: toB64(raw), ...sealed }
}

async function eciesOpen(privateKey: CryptoKey, payload: { ephemeralPublicKey: string } & Sealed, salt: string, info: string, aad: string): Promise<Bytes> {
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublic(payload.ephemeralPublicKey) }, privateKey, 256))
	const key = await hkdfKey(shared, enc.encode(salt), info, ["decrypt"])
	return openWith(key, payload, aad)
}

export async function sealAkForIdentity(ak: Uint8Array, identityPublicKey: string, userId: string): Promise<SlotPayload> {
	const sealed = await eciesSeal(identityPublicKey, ak, "fx:ak-identity:" + userId, "fx:ak-identity:v1", akAad(userId, "identity"))
	return {
		kind: "identity",
		kdf: { alg: "ECIES-P256", ephemeralPublicKey: sealed.ephemeralPublicKey },
		iv: sealed.iv,
		ciphertext: sealed.ciphertext,
		label: await fingerprint(identityPublicKey),
	}
}

export async function openAkWithIdentity(slot: SlotPayload, identityPrivateKey: string, userId: string): Promise<Bytes> {
	const ephemeralPublicKey = String(slot.kdf.ephemeralPublicKey ?? "")
	return eciesOpen(await importPrivate(identityPrivateKey), { ephemeralPublicKey, iv: slot.iv, ciphertext: slot.ciphertext }, "fx:ak-identity:" + userId, "fx:ak-identity:v1", akAad(userId, "identity"))
}

export async function sealIdentity(ak: Uint8Array, identity: Identity, userId: string): Promise<{ scope: "identity"; itemId: string } & Sealed> {
	const itemId = await fingerprint(identity.publicKey)
	const sealed = await sealWith(await aesKey(ak), enc.encode(JSON.stringify(identity)), "fx:vault:identity:v1:" + userId + ":" + itemId)
	return { scope: "identity", itemId, ...sealed }
}

export async function openIdentity(ak: Uint8Array, item: { itemId: string } & Sealed, userId: string): Promise<Identity> {
	const opened = await openWith(await aesKey(ak), item, "fx:vault:identity:v1:" + userId + ":" + item.itemId)
	const parsed = JSON.parse(dec.decode(opened)) as Identity
	if (!parsed || typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string") throw new Error("identity item is invalid")
	return parsed
}

// --- conversation keys --------------------------------------------------------------

export function newConversationKey(): Bytes {
	return randomBytes(32)
}

export function newKeyId(): string {
	return "k_" + toB64Url(randomBytes(12))
}

const cekAad = (userId: string, conversationId: string, keyId: string) => "fx:vault:cek:v1:" + userId + ":" + conversationId + ":" + keyId

export async function sealCek(ak: Uint8Array, cek: Uint8Array, userId: string, conversationId: string, keyId: string): Promise<Sealed> {
	return sealWith(await aesKey(ak), cek, cekAad(userId, conversationId, keyId))
}

export async function openCek(ak: Uint8Array, item: Sealed, userId: string, conversationId: string, keyId: string): Promise<Bytes> {
	return openWith(await aesKey(ak), item, cekAad(userId, conversationId, keyId))
}

// Published with every new key: members check that the key they received is
// the one everybody else got, so a member cannot hand out a different one.
export async function cekCheck(cek: Uint8Array, conversationId: string, keyId: string): Promise<string> {
	const sealed = await sealWith(await aesKey(cek), enc.encode("frontierx-conversation-key"), "fx:cek-check:v1:" + conversationId + ":" + keyId)
	return toB64(concat(fromB64(sealed.iv), fromB64(sealed.ciphertext)))
}

export async function verifyCek(cek: Uint8Array, conversationId: string, keyId: string, check: string | null): Promise<boolean> {
	if (!check) return true
	try {
		const raw = fromB64(check)
		const opened = await openWith(await aesKey(cek), { iv: toB64(raw.subarray(0, 12)), ciphertext: toB64(raw.subarray(12)) }, "fx:cek-check:v1:" + conversationId + ":" + keyId)
		return dec.decode(opened) === "frontierx-conversation-key"
	} catch {
		return false
	}
}

export interface WrappedShare {
	ephemeralPublicKey: string
	iv: string
	ciphertext: string
}

// The "legacy" key keeps the first key system's wrapping so the copies older
// builds made still open (and older builds can open the ones made here).
const LEGACY_INFO = "frontierx:cek-wrap"

async function legacyKek(privateKey: CryptoKey, publicKey: CryptoKey, conversationId: string, usage: KeyUsage[]): Promise<CryptoKey> {
	const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
	const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
	return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("frontierx:" + conversationId), info: enc.encode(LEGACY_INFO) }, base, { name: "AES-GCM", length: 256 }, false, usage)
}

export async function wrapShare(recipientPublicKey: string, conversationId: string, keyId: string, cek: Uint8Array): Promise<WrappedShare> {
	if (keyId === "legacy") {
		const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
		const kek = await legacyKek(ephemeral.privateKey, await importPublic(recipientPublicKey), conversationId, ["encrypt"])
		const iv = randomBytes(12)
		const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, bytes(cek)))
		const raw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
		return { ephemeralPublicKey: toB64(raw), iv: toB64(iv), ciphertext: toB64(sealed) }
	}
	const sealed = await eciesSeal(recipientPublicKey, cek, "fx:share:" + conversationId + ":" + keyId, "fx:share:v2", "fx:share:v2:" + conversationId + ":" + keyId)
	return sealed
}

export async function unwrapShare(identityPrivateKey: string, conversationId: string, keyId: string, share: WrappedShare): Promise<Bytes> {
	const priv = await importPrivate(identityPrivateKey)
	if (keyId === "legacy") {
		const kek = await legacyKek(priv, await importPublic(share.ephemeralPublicKey), conversationId, ["decrypt"])
		return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(share.iv) }, kek, fromB64(share.ciphertext)))
	}
	return eciesOpen(priv, share, "fx:share:" + conversationId + ":" + keyId, "fx:share:v2", "fx:share:v2:" + conversationId + ":" + keyId)
}

// --- linking a device --------------------------------------------------------------

export async function newLinkKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"])
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	return { publicKey: toB64(raw), privateKey: pair.privateKey }
}

// 16 digits derived from the new device's one-time key. Both screens show it;
// if they match, the key really came from that device and not from somebody
// in between. 53 bits is far beyond what can be ground out for a request that
// lives ten minutes.
export async function linkCode(ephemeralPublicKey: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(enc.encode("fx-link-code:v1"), fromB64(ephemeralPublicKey))))
	let value = 0n
	for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(digest[i])
	const digits = (value % 10000000000000000n).toString().padStart(16, "0")
	return digits.replace(/(\d{4})(?=\d)/g, "$1 ")
}

export async function sealAkForLink(ak: Uint8Array, linkPublicKey: string, userId: string): Promise<WrappedShare> {
	return eciesSeal(linkPublicKey, ak, "fx:link:" + userId, "fx:link:v1", akAad(userId, "link"))
}

export async function openAkFromLink(response: WrappedShare, linkPrivateKey: CryptoKey, userId: string): Promise<Bytes> {
	return eciesOpen(linkPrivateKey, response, "fx:link:" + userId, "fx:link:v1", akAad(userId, "link"))
}

// --- message envelopes -------------------------------------------------------------

export type Envelope = { version: 1; body: string } | { version: 2; keyId: string; body: string } | null

export function parseEnvelope(value: string): Envelope {
	if (value.startsWith("fx1:")) return { version: 1, body: value.slice(4) }
	if (value.startsWith("fx2:")) {
		const rest = value.slice(4)
		const sep = rest.indexOf(":")
		if (sep <= 0) return null
		return { version: 2, keyId: rest.slice(0, sep), body: rest.slice(sep + 1) }
	}
	return null
}

export function isSealedMessage(value: string): boolean {
	return value.startsWith("fx1:") || value.startsWith("fx2:")
}

const messageAad = (conversationId: string, keyId: string) => "fx2|" + conversationId + "|" + keyId

export async function sealMessage(key: CryptoKey, conversationId: string, keyId: string, plaintext: string): Promise<string> {
	const iv = randomBytes(12)
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(messageAad(conversationId, keyId)) }, key, enc.encode(plaintext)))
	return "fx2:" + keyId + ":" + toB64(concat(iv, sealed))
}

export async function openMessage(key: CryptoKey, conversationId: string, envelope: Envelope): Promise<string> {
	if (!envelope) throw new Error("not an encrypted message")
	const packed = fromB64(envelope.body)
	if (envelope.version === 1) {
		// fx1: version byte, 12-byte IV, ciphertext; no additional data.
		const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(1, 13) }, key, packed.slice(13))
		return dec.decode(opened)
	}
	const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12), additionalData: enc.encode(messageAad(conversationId, envelope.keyId)) }, key, packed.slice(12))
	return dec.decode(opened)
}

export async function importCek(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", bytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}
