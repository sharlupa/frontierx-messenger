const PREFIX = "fx1:"
const PBKDF2_ITERATIONS = 210000
const IV_BYTES = 12
const VERSION = 1

const keyCache = new Map<string, Promise<CryptoKey>>()

function saltFor(conversationId: string) {
	return new TextEncoder().encode("frontierx:" + conversationId)
}

function deriveKey(conversationId: string, passphrase: string): Promise<CryptoKey> {
	const cacheKey = conversationId + "\u0000" + passphrase
	const cached = keyCache.get(cacheKey)
	if (cached) return cached
	const promise = (async () => {
		const baseKey = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(passphrase),
			"PBKDF2",
			false,
			["deriveKey"],
		)
		return crypto.subtle.deriveKey(
			{
				name: "PBKDF2",
				salt: saltFor(conversationId),
				iterations: PBKDF2_ITERATIONS,
				hash: "SHA-256",
			},
			baseKey,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		)
	})()
	keyCache.set(cacheKey, promise)
	return promise
}

function toBase64(bytes: Uint8Array): string {
	let binary = ""
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

export function isEncrypted(value: string): boolean {
	return value.startsWith(PREFIX)
}

export async function encryptText(
	conversationId: string,
	passphrase: string,
	plaintext: string,
): Promise<string> {
	const key = await deriveKey(conversationId, passphrase)
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
	)
	const packed = new Uint8Array(1 + IV_BYTES + ciphertext.length)
	packed[0] = VERSION
	packed.set(iv, 1)
	packed.set(ciphertext, 1 + IV_BYTES)
	return PREFIX + toBase64(packed)
}

export async function decryptText(
	conversationId: string,
	passphrase: string,
	value: string,
): Promise<string> {
	if (!isEncrypted(value)) return value
	const packed = fromBase64(value.slice(PREFIX.length))
	const iv = packed.slice(1, 1 + IV_BYTES)
	const ciphertext = packed.slice(1 + IV_BYTES)
	const key = await deriveKey(conversationId, passphrase)
	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
	return new TextDecoder().decode(plaintext)
}

export async function encryptWithKey(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  )
  const packed = new Uint8Array(1 + IV_BYTES + ciphertext.length)
  packed[0] = VERSION
  packed.set(iv, 1)
  packed.set(ciphertext, 1 + IV_BYTES)
  return PREFIX + toBase64(packed)
}

export async function decryptWithKey(key: CryptoKey, value: string): Promise<string> {
  if (!isEncrypted(value)) return value
  const packed = fromBase64(value.slice(PREFIX.length))
  const iv = packed.slice(1, 1 + IV_BYTES)
  const ciphertext = packed.slice(1 + IV_BYTES)
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}
