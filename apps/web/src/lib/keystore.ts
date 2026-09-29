import { fromB64, toB64, type Bytes, type Identity } from "./keyvault"

// Keys kept on this device, one set per account: the account key and the
// identity keys it unlocked. They stay when a session ends (so signing in again
// needs nothing but the password, even right after a password reset) and are
// wiped when the account is removed from the device.

const AK_PREFIX = "fx.ak."
const ID_PREFIX = "fx.ids."
// The first key system kept one identity key per browser in these slots.
const LEGACY_SLOT = "fx.idpriv"
const LEGACY_OWNER = "fx.idowner"

function get(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

function set(key: string, value: string): void {
	try {
		localStorage.setItem(key, value)
	} catch {
		// storage full or blocked: the key lives for this page only
	}
}

function remove(key: string): void {
	try {
		localStorage.removeItem(key)
	} catch {
		// nothing to remove
	}
}

export function loadAccountKey(userId: string): Bytes | null {
	const raw = get(AK_PREFIX + userId)
	if (!raw) return null
	try {
		const value = fromB64(raw)
		return value.length === 32 ? value : null
	} catch {
		return null
	}
}

export function storeAccountKey(userId: string, ak: Uint8Array): void {
	set(AK_PREFIX + userId, toB64(ak))
}

export function forgetAccountKey(userId: string): void {
	remove(AK_PREFIX + userId)
}

export function loadIdentities(userId: string): Identity[] {
	const raw = get(ID_PREFIX + userId)
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw) as unknown
		return Array.isArray(parsed) ? parsed.filter((item): item is Identity => Boolean(item) && typeof (item as Identity).publicKey === "string" && typeof (item as Identity).privateKey === "string") : []
	} catch {
		return []
	}
}

export function storeIdentities(userId: string, identities: Identity[]): void {
	const seen = new Set<string>()
	const unique = identities.filter((item) => (seen.has(item.publicKey) ? false : (seen.add(item.publicKey), true)))
	set(ID_PREFIX + userId, JSON.stringify(unique))
}

export function addIdentities(userId: string, identities: Identity[]): Identity[] {
	const merged = loadIdentities(userId).concat(identities)
	storeIdentities(userId, merged)
	return loadIdentities(userId)
}

export function forgetAccountKeys(userId: string): void {
	remove(AK_PREFIX + userId)
	remove(ID_PREFIX + userId)
	remove(LEGACY_SLOT + "." + userId)
	if (get(LEGACY_OWNER) === userId) {
		remove(LEGACY_SLOT)
		remove(LEGACY_OWNER)
	}
}

// Private keys the first key system left in this browser for this account.
// The unowned slot is only trusted when no other account claimed it.
export function legacyPrivateKeys(userId: string): string[] {
	const out: string[] = []
	const own = get(LEGACY_SLOT + "." + userId)
	if (own) out.push(own)
	const shared = get(LEGACY_SLOT)
	const owner = get(LEGACY_OWNER)
	if (shared && (owner === null || owner === userId) && !out.includes(shared)) out.push(shared)
	return out
}

// Once the account key holds them, the loose copies are removed. The unowned
// shared slot may still be another account's only copy, so it is left alone.
export function clearLegacyPrivateKeys(userId: string): void {
	remove(LEGACY_SLOT + "." + userId)
	if (get(LEGACY_OWNER) === userId) {
		remove(LEGACY_SLOT)
		remove(LEGACY_OWNER)
	}
}
