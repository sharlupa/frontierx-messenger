import type { User } from "./types"

// Signed-in accounts on this device. Several accounts can live side by side;
// one of them is active and everything the app shows belongs to it. Switching
// reloads the page, so no state of one account can leak into another.
//
// Each account keeps its own session token and user record here; its keys live
// in keystore.ts, its device-local preferences under accountKey().

export type StoredAccount = {
	id: string
	username: string
	displayName: string
	avatar: string | null
	// null once the session ended (signed out elsewhere, expired): the account
	// stays in the list and its keys stay on the device until it is removed.
	token: string | null
	addedAt: string
}

export const MAX_ACCOUNTS = 5

const ACCOUNTS_KEY = "fx.accounts.v1"
const ACTIVE_KEY = "fx.active"
const LEGACY_TOKEN_KEY = "fx.token"
const LEGACY_USER_KEY = "fx.user"
const KEY_PREFIX = "fx.key."

function read<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key)
		return raw ? (JSON.parse(raw) as T) : fallback
	} catch {
		return fallback
	}
}

function write(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value))
	} catch {
		// storage full or blocked: the change lasts for this page
	}
}

function isAccount(value: unknown): value is StoredAccount {
	if (!value || typeof value !== "object") return false
	const v = value as StoredAccount
	return typeof v.id === "string" && v.id.length > 0 && typeof v.username === "string" && (v.token === null || typeof v.token === "string")
}

// The single-account storage of earlier builds becomes the first account.
function migrateLegacy(): void {
	try {
		const token = localStorage.getItem(LEGACY_TOKEN_KEY)
		const rawUser = localStorage.getItem(LEGACY_USER_KEY)
		if (!token || !rawUser) return
		const user = JSON.parse(rawUser) as User
		if (!user || !user.id) return
		const accounts = read<unknown[]>(ACCOUNTS_KEY, []).filter(isAccount)
		if (!accounts.some((account) => account.id === user.id)) {
			accounts.push({ id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar ?? null, token, addedAt: new Date().toISOString() })
			write(ACCOUNTS_KEY, accounts)
		}
		if (!localStorage.getItem(ACTIVE_KEY)) localStorage.setItem(ACTIVE_KEY, user.id)
		localStorage.removeItem(LEGACY_TOKEN_KEY)
		localStorage.removeItem(LEGACY_USER_KEY)
	} catch {
		// keep the legacy keys; the next start tries again
	}
}

let migrated = false
function ensureMigrated(): void {
	if (migrated) return
	migrated = true
	migrateLegacy()
}

export function listAccounts(): StoredAccount[] {
	ensureMigrated()
	return read<unknown[]>(ACCOUNTS_KEY, []).filter(isAccount)
}

function saveAccounts(accounts: StoredAccount[]): void {
	write(ACCOUNTS_KEY, accounts)
}

export function getActiveAccountId(): string | null {
	ensureMigrated()
	try {
		const id = localStorage.getItem(ACTIVE_KEY)
		if (id && listAccounts().some((account) => account.id === id)) return id
	} catch {
		// fall through
	}
	const first = listAccounts().find((account) => account.token)
	return first ? first.id : null
}

export function getActiveAccount(): StoredAccount | null {
	const id = getActiveAccountId()
	return id ? listAccounts().find((account) => account.id === id) ?? null : null
}

export function setActiveAccountId(id: string): void {
	try {
		localStorage.setItem(ACTIVE_KEY, id)
	} catch {
		// the switch lasts for this page
	}
}

export function getToken(): string | null {
	return getActiveAccount()?.token ?? null
}

export function getStoredUser(): User | null {
	const account = getActiveAccount()
	if (!account || !account.token) return null
	return { id: account.id, username: account.username, displayName: account.displayName, avatar: account.avatar }
}

// Signing in (or registering) stores the session and makes it the active one.
export function setSession(token: string, user: User): void {
	const accounts = listAccounts()
	const existing = accounts.find((account) => account.id === user.id)
	if (existing) {
		existing.token = token
		existing.username = user.username
		existing.displayName = user.displayName
		existing.avatar = user.avatar ?? null
	} else {
		accounts.push({ id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar ?? null, token, addedAt: new Date().toISOString() })
	}
	saveAccounts(accounts)
	setActiveAccountId(user.id)
}

export function updateStoredUser(user: User): void {
	const accounts = listAccounts()
	const existing = accounts.find((account) => account.id === user.id)
	if (!existing) return
	existing.username = user.username
	existing.displayName = user.displayName
	existing.avatar = user.avatar ?? null
	saveAccounts(accounts)
}

// The session is gone but the account (and its keys) stay on the device.
export function markSignedOut(accountId: string): void {
	const accounts = listAccounts()
	const existing = accounts.find((account) => account.id === accountId)
	if (!existing) return
	existing.token = null
	saveAccounts(accounts)
}

// Forgets the account on this device entirely, including its local settings.
export function removeAccount(accountId: string): void {
	saveAccounts(listAccounts().filter((account) => account.id !== accountId))
	try {
		const prefix = "fx.acct." + accountId + "."
		const doomed: string[] = []
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i)
			if (key && key.startsWith(prefix)) doomed.push(key)
		}
		for (const key of doomed) localStorage.removeItem(key)
		if (localStorage.getItem(ACTIVE_KEY) === accountId) {
			const next = listAccounts().find((account) => account.token)
			if (next) localStorage.setItem(ACTIVE_KEY, next.id)
			else localStorage.removeItem(ACTIVE_KEY)
		}
	} catch {
		// nothing more to clean
	}
}

// Storage key for a device-local preference of the active account (pinned
// chats, outbox, open folder...). Falls back to the bare key before sign-in.
export function accountKey(base: string, accountId: string | null = getActiveAccountId()): string {
	return accountId ? "fx.acct." + accountId + "." + base : base
}

// One-time move of a preference that earlier builds kept without an account.
export function adoptLegacyPreference(base: string): void {
	const accountId = getActiveAccountId()
	if (!accountId) return
	try {
		const legacy = localStorage.getItem(base)
		const scoped = accountKey(base, accountId)
		if (legacy !== null && localStorage.getItem(scoped) === null) localStorage.setItem(scoped, legacy)
		if (legacy !== null) localStorage.removeItem(base)
	} catch {
		// keep using the legacy value
	}
}

export function clearSession(): void {
	const id = getActiveAccountId()
	if (id) markSignedOut(id)
}

export function getPassphrase(conversationId: string): string | null {
	return sessionStorage.getItem(KEY_PREFIX + conversationId)
}

export function setPassphrase(conversationId: string, passphrase: string): void {
	if (passphrase) {
		sessionStorage.setItem(KEY_PREFIX + conversationId, passphrase)
	} else {
		sessionStorage.removeItem(KEY_PREFIX + conversationId)
	}
}

export function hasPassphrase(conversationId: string): boolean {
	return !!getPassphrase(conversationId)
}

const DEVICE_KEY = "fx.deviceId"

export function getDeviceId(): string {
	let id = localStorage.getItem(DEVICE_KEY)
	if (!id) {
		const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined
		id = cryptoObj && typeof cryptoObj.randomUUID === "function" ? cryptoObj.randomUUID() : "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
		localStorage.setItem(DEVICE_KEY, id)
	}
	return id
}
