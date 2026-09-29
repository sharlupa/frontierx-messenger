import { api, ApiError } from "./api"
import * as kv from "./keyvault"
import type { Bytes, Identity } from "./keyvault"
import { addIdentities, clearLegacyPrivateKeys, forgetAccountKey, legacyPrivateKeys, loadAccountKey, loadIdentities, storeAccountKey } from "./keystore"
import { unwrapIdentityWithPassword, wrapIdentityWithPassword } from "./keys"
import type { KeySession } from "./keyring"
import type { KeyStateResponse, SlotInput, StoredSlotInfo, VaultItemInput } from "./types"

// Getting a device to hold the account key.
//
// On every sign-in and every start the device looks for the account key in
// this order: its own copy, the password slot (with the password just typed),
// the identity slot (with identity keys the first key system left here or in
// the old password backup). If none works the account is "locked" and the
// person picks a way back: recovery key, previous password, approval from
// another device, or starting over.
//
// Accounts from before key system v2 get their account key here the first
// time they sign in, with every identity key found; nothing is thrown away.

export type LockedInfo = {
	hasPasswordSlot: boolean
	hasStalePasswordSlot: boolean
	hasRecoverySlot: boolean
	hasLegacyBackup: boolean
	passwordChangedAt: string | null
	// The password typed at sign-in did not open anything (reset elsewhere).
	triedPassword: boolean
}

export type KeySetup = { status: "ready"; session: KeySession; health: KeyHealth } | { status: "locked"; info: LockedInfo }

// What the security settings show and nudge about.
export type KeyHealth = {
	hasPasswordSlot: boolean
	hasRecoverySlot: boolean
	vaultCount: number
}

function slotsOf(state: KeyStateResponse, kind: "password" | "recovery" | "identity"): StoredSlotInfo[] {
	return state.slots.filter((slot) => slot.kind === kind)
}

function healthOf(state: KeyStateResponse): KeyHealth {
	return {
		hasPasswordSlot: slotsOf(state, "password").some((slot) => !slot.stale),
		hasRecoverySlot: slotsOf(state, "recovery").length > 0,
		vaultCount: state.vaultCount,
	}
}

function lockedInfo(state: KeyStateResponse, triedPassword: boolean): LockedInfo {
	return {
		hasPasswordSlot: slotsOf(state, "password").some((slot) => !slot.stale),
		hasStalePasswordSlot: slotsOf(state, "password").some((slot) => slot.stale),
		hasRecoverySlot: slotsOf(state, "recovery").length > 0,
		hasLegacyBackup: Boolean(state.legacyBackup),
		passwordChangedAt: state.passwordChangedAt,
		triedPassword,
	}
}

async function identityFromPrivate(privateKey: string): Promise<Identity | null> {
	try {
		return { privateKey, publicKey: await kv.publicKeyOf(privateKey) }
	} catch {
		return null
	}
}

// Identity keys this device can find without the account key: the ones kept
// by key system v2 and the loose copies of the first key system.
async function localIdentities(userId: string): Promise<Identity[]> {
	const out = loadIdentities(userId)
	for (const privateKey of legacyPrivateKeys(userId)) {
		const identity = await identityFromPrivate(privateKey)
		if (identity && !out.some((item) => item.publicKey === identity.publicKey)) out.push(identity)
	}
	return out
}

async function legacyBackupIdentity(state: KeyStateResponse, password: string): Promise<Identity | null> {
	if (!state.legacyBackup) return null
	try {
		return await identityFromPrivate(await unwrapIdentityWithPassword(state.legacyBackup, password))
	} catch {
		return null
	}
}

async function tryPasswordSlots(state: KeyStateResponse, userId: string, password: string, includeStale: boolean): Promise<Bytes | null> {
	const slots = slotsOf(state, "password").filter((slot) => includeStale || !slot.stale).sort((a, b) => Number(a.stale) - Number(b.stale))
	for (const slot of slots) {
		try {
			const ak = await kv.openAkWithPassword(slot, password, userId)
			if (await kv.verifyAccountKey(ak, userId, state.accountKey?.check)) return ak
		} catch {
			// wrong password for this slot
		}
	}
	return null
}

async function tryIdentitySlots(state: KeyStateResponse, userId: string, identities: Identity[]): Promise<Bytes | null> {
	for (const slot of slotsOf(state, "identity")) {
		for (const identity of identities) {
			try {
				const ak = await kv.openAkWithIdentity(slot, identity.privateKey, userId)
				if (await kv.verifyAccountKey(ak, userId, state.accountKey?.check)) return ak
			} catch {
				// not this identity
			}
		}
	}
	return null
}

// With the account key in hand: open the vault's identities, add any found on
// this device, repair slots that are missing or stale, keep it on the device.
async function finish(userId: string, ak: Bytes, state: KeyStateResponse, password: string | null, found: Identity[] = []): Promise<KeySetup> {
	storeAccountKey(userId, ak)
	const identities: Identity[] = []
	for (const item of state.identities) {
		try {
			identities.push(await kv.openIdentity(ak, item, userId))
		} catch {
			// an item that does not open is skipped
		}
	}
	const known = new Set(identities.map((identity) => identity.publicKey))
	const extra: Identity[] = []
	for (const identity of found.concat(await localIdentities(userId))) {
		if (known.has(identity.publicKey)) continue
		known.add(identity.publicKey)
		extra.push(identity)
	}
	// Identity keys only this device had go into the vault, so the account
	// never depends on this device again.
	if (extra.length > 0) {
		const items: VaultItemInput[] = []
		for (const identity of extra) items.push(await kv.sealIdentity(ak, identity, userId))
		try {
			await api.putVault(items)
		} catch {
			// kept locally; the next start tries again
		}
		identities.push(...extra)
	}
	let current = identities.find((identity) => identity.publicKey === state.publicKey) ?? null
	if (!current && !state.publicKey) {
		// The account never published an identity: create one now.
		current = await kv.generateIdentity()
		identities.push(current)
		try {
			await api.putVault([await kv.sealIdentity(ak, current, userId)])
			await api.publishPublicKey(current.publicKey)
			await api.putKeySlot(await kv.sealAkForIdentity(ak, current.publicKey, userId))
		} catch {
			// retried on the next start
		}
	}
	// Kept in this device's key store (and retried into the vault next time),
	// so the loose copies of the first key system can go.
	addIdentities(userId, identities)
	clearLegacyPrivateKeys(userId)
	const session: KeySession = { userId, ak, identities, publicKey: current ? current.publicKey : state.publicKey }
	let latest = state
	try {
		latest = await repairSlots(session, state, password)
	} catch {
		// slots stay as they are until the next start
	}
	return { status: "ready", session, health: healthOf(latest) }
}

async function repairSlots(session: KeySession, state: KeyStateResponse, password: string | null): Promise<KeyStateResponse> {
	const { userId, ak } = session
	let changed = false
	const current = session.identities.find((identity) => identity.publicKey === session.publicKey) ?? null
	if (current) {
		const fp = await kv.fingerprint(current.publicKey)
		if (!slotsOf(state, "identity").some((slot) => slot.label === fp)) {
			await api.putKeySlot(await kv.sealAkForIdentity(ak, current.publicKey, userId))
			changed = true
		}
	}
	if (password) {
		const passwordSlots = slotsOf(state, "password")
		// After a reset the slot is stale; with no slot at all it never existed.
		if (passwordSlots.length === 0 || passwordSlots.every((slot) => slot.stale)) {
			await api.putKeySlot({ ...(await kv.sealAkWithPassword(ak, password, userId)), password } as SlotInput & { password: string })
			changed = true
		}
		// Older builds restore the identity from this backup; keep it current.
		if (current && (!state.legacyBackup || state.legacyBackup.publicKey !== current.publicKey || passwordSlots.some((slot) => slot.stale))) {
			try {
				await api.putKeyBackup(await wrapIdentityWithPassword(current, password))
			} catch {
				// optional
			}
		}
	}
	return changed ? await api.keyState() : state
}

// First account key of an account: brand new, or migrating from the first
// key system with whatever identity keys can be found.
async function createAccountKey(userId: string, state: KeyStateResponse, password: string | null): Promise<KeySetup> {
	const identities = await localIdentities(userId)
	if (password) {
		const fromBackup = await legacyBackupIdentity(state, password)
		if (fromBackup && !identities.some((identity) => identity.publicKey === fromBackup.publicKey)) identities.push(fromBackup)
	}
	let current = identities.find((identity) => identity.publicKey === state.publicKey) ?? null
	if (!current) {
		// Without a password the old backup could not be tried; asking for it
		// is better than giving up the identity the other members know.
		if (!password && state.legacyBackup && state.publicKey) return { status: "locked", info: lockedInfo(state, false) }
		current = identities[0] ?? (await kv.generateIdentity())
		if (!identities.includes(current)) identities.push(current)
	}
	const ak = kv.newAccountKey()
	const slots: SlotInput[] = [await kv.sealAkForIdentity(ak, current.publicKey, userId)]
	if (password) slots.push(await kv.sealAkWithPassword(ak, password, userId))
	const vault: VaultItemInput[] = []
	for (const identity of identities) vault.push(await kv.sealIdentity(ak, identity, userId))
	try {
		const created = await api.createAccountKey({
			password: password ?? undefined,
			publicKey: current.publicKey,
			check: await kv.accountKeyCheck(ak, userId),
			slots,
			vault,
		})
		const ready = await finish(userId, ak, created, password, identities)
		if (password && ready.status === "ready") {
			try {
				await api.putKeyBackup(await wrapIdentityWithPassword(current, password))
			} catch {
				// optional
			}
		}
		return ready
	} catch (error) {
		// Another device created it a moment earlier: unlock that one instead.
		if (error instanceof ApiError && error.status === 409) return setupKeys(userId, password)
		throw error
	}
}

export async function setupKeys(userId: string, password: string | null): Promise<KeySetup> {
	const state = await api.keyState()
	if (!state.accountKey) return createAccountKey(userId, state, password)
	const local = loadAccountKey(userId)
	if (local) {
		if (await kv.verifyAccountKey(local, userId, state.accountKey.check)) return finish(userId, local, state, password)
		// The account key was replaced elsewhere (started over): this copy is dead.
		forgetAccountKey(userId)
	}
	if (password) {
		const ak = await tryPasswordSlots(state, userId, password, true)
		if (ak) return finish(userId, ak, state, password)
	}
	const identities = await localIdentities(userId)
	if (password) {
		const fromBackup = await legacyBackupIdentity(state, password)
		if (fromBackup) identities.push(fromBackup)
	}
	const viaIdentity = await tryIdentitySlots(state, userId, identities)
	if (viaIdentity) return finish(userId, viaIdentity, state, password, identities)
	return { status: "locked", info: lockedInfo(state, Boolean(password)) }
}

// --- ways back when locked ------------------------------------------------------

export class WrongSecretError extends Error {
	constructor() {
		super("that did not unlock the keys")
		this.name = "WrongSecretError"
	}
}

// `secret` is the password to try: the current one, or the one from before a
// reset. `sealWith` is the account password to seal the keys with afterwards
// (null when it is not known on this screen).
export async function unlockWithPassword(userId: string, secret: string, sealWith: string | null): Promise<KeySetup> {
	const state = await api.keyState()
	if (!state.accountKey) return createAccountKey(userId, state, sealWith ?? secret)
	const ak = await tryPasswordSlots(state, userId, secret, true)
	if (ak) return finish(userId, ak, state, sealWith)
	const identities = await localIdentities(userId)
	const fromBackup = await legacyBackupIdentity(state, secret)
	if (fromBackup) identities.push(fromBackup)
	const viaIdentity = await tryIdentitySlots(state, userId, identities)
	if (viaIdentity) return finish(userId, viaIdentity, state, sealWith, identities)
	throw new WrongSecretError()
}

export async function unlockWithRecoveryKey(userId: string, code: string, currentPassword: string | null): Promise<KeySetup> {
	const recovery = await kv.parseRecoveryKey(code)
	if (!recovery) throw new WrongSecretError()
	const state = await api.keyState()
	for (const slot of slotsOf(state, "recovery")) {
		try {
			const ak = await kv.openAkWithRecovery(slot, recovery, userId)
			if (await kv.verifyAccountKey(ak, userId, state.accountKey?.check)) return finish(userId, ak, state, currentPassword)
		} catch {
			// not this slot
		}
	}
	throw new WrongSecretError()
}

// The new device's half of linking: shows a code, waits for approval.
export type LinkAttempt = {
	id: string
	code: string
	expiresAt: string
	// Resolves once another device approved (or rejects if denied/expired).
	wait: (signal: { cancelled: boolean }) => Promise<KeySetup>
}

export async function startLink(userId: string, label: string, currentPassword: string | null): Promise<LinkAttempt> {
	const pair = await kv.newLinkKeyPair()
	const created = await api.startLink({ ephemeralPublicKey: pair.publicKey, label })
	const code = await kv.linkCode(pair.publicKey)
	const wait = async (signal: { cancelled: boolean }): Promise<KeySetup> => {
		for (;;) {
			if (signal.cancelled) throw new Error("cancelled")
			let result: Awaited<ReturnType<typeof api.pollLink>>
			try {
				result = await api.pollLink(created.id)
			} catch (error) {
				if (error instanceof ApiError && (error.status === 404 || error.status === 410)) throw new Error("expired")
				await new Promise((resolve) => setTimeout(resolve, 3000))
				continue
			}
			if (result.status === "denied") throw new Error("denied")
			if (result.status === "approved" && result.response) {
				const ak = await kv.openAkFromLink(result.response, pair.privateKey, userId)
				const state = await api.keyState()
				if (!(await kv.verifyAccountKey(ak, userId, state.accountKey?.check))) throw new WrongSecretError()
				return finish(userId, ak, state, currentPassword)
			}
			await new Promise((resolve) => setTimeout(resolve, 2000))
		}
	}
	return { id: created.id, code, expiresAt: created.expiresAt, wait }
}

// The trusted device's half: after the person compared the codes.
export async function approveLink(session: KeySession, request: { id: string; ephemeralPublicKey: string }): Promise<void> {
	const response = await kv.sealAkForLink(session.ak, request.ephemeralPublicKey, session.userId)
	await api.approveLink(request.id, response)
}

// Everything else is lost: a fresh account key and identity. Chats with other
// people come back as their devices hand the keys over.
export async function startOver(userId: string, password: string): Promise<KeySetup> {
	const identity = await kv.generateIdentity()
	const ak = kv.newAccountKey()
	const slots: SlotInput[] = [await kv.sealAkWithPassword(ak, password, userId), await kv.sealAkForIdentity(ak, identity.publicKey, userId)]
	const created = await api.resetAccountKeys({
		password,
		publicKey: identity.publicKey,
		check: await kv.accountKeyCheck(ak, userId),
		slots,
		vault: [await kv.sealIdentity(ak, identity, userId)],
	})
	forgetAccountKey(userId)
	try {
		await api.putKeyBackup(await wrapIdentityWithPassword(identity, password))
	} catch {
		// optional
	}
	return finish(userId, ak, created, password, [identity])
}

// --- settings -----------------------------------------------------------------------

export async function createRecoveryKey(session: KeySession): Promise<string> {
	const { code, bytes } = await kv.newRecoveryKey()
	await api.putKeySlot(await kv.sealAkWithRecovery(session.ak, bytes, session.userId))
	return code
}

export async function changePassword(session: KeySession, currentPassword: string, newPassword: string, signOutOthers: boolean): Promise<void> {
	const slot = await kv.sealAkWithPassword(session.ak, newPassword, session.userId)
	const current = session.identities.find((identity) => identity.publicKey === session.publicKey)
	const legacyBackup = current ? await wrapIdentityWithPassword(current, newPassword) : null
	await api.changePassword({ currentPassword, newPassword, passwordSlot: slot, legacyBackup, signOutOthers })
}

// Seals the keys with the current password where no password slot exists
// (accounts upgraded on a device that never asked for it).
export async function addPasswordSlot(session: KeySession, password: string): Promise<void> {
	await api.putKeySlot({ ...(await kv.sealAkWithPassword(session.ak, password, session.userId)), password } as SlotInput & { password: string })
}

export async function keyHealth(): Promise<KeyHealth> {
	return healthOf(await api.keyState())
}
