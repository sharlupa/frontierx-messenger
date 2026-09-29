import { api, ApiError } from "./api"
import * as kv from "./keyvault"
import type { Bytes, Identity } from "./keyvault"
import type { KeyEpochInfo, MissingShare, ShareInfo, ShareInput, VaultItemInput } from "./types"

// Conversation keys of the signed-in account.
//
// A conversation can have many keys over time (epochs); every message names
// the one it was sealed with. The keyring opens keys from the account vault
// first (sealed with the account key, so they survive any device change), then
// from copies other members wrapped for this account, and seals every key it
// learns into the vault. It also hands keys to members who still lack them,
// which is what makes history reachable on every device and for new members.

export class KeyUnavailableError extends Error {
	constructor(readonly conversationId: string, readonly keyId: string | null) {
		super("conversation key unavailable")
		this.name = "KeyUnavailableError"
	}
}

export interface KeySession {
	userId: string
	ak: Bytes
	identities: Identity[]
	// The identity the server publishes for this account.
	publicKey: string | null
}

type ConvState = {
	currentKeyId: string | null
	rekeyNeeded: boolean
	epochs: Map<string, KeyEpochInfo>
	loadedAt: number
}

// Retries must never keep a process alive on their own (tests, tooling).
function background<T>(timer: T): T {
	const handle = timer as unknown as { unref?: () => void }
	if (handle && typeof handle.unref === "function") handle.unref()
	return timer
}

const STATE_TTL_MS = 60000
const RETRY_MISSING_MS = 8000

export class Keyring {
	private keys = new Map<string, CryptoKey>()
	private raws = new Map<string, Bytes>()
	private states = new Map<string, ConvState>()
	private loading = new Map<string, Promise<ConvState>>()
	private minting = new Map<string, Promise<{ keyId: string; key: CryptoKey }>>()
	private lastMiss = new Map<string, number>()
	private rejected = new Set<string>()
	private vaultQueue: VaultItemInput[] = []
	private vaultTimer: ReturnType<typeof setTimeout> | null = null
	private listeners = new Set<(conversationId: string) => void>()
	private syncing = false

	constructor(readonly session: KeySession) {}

	get userId(): string {
		return this.session.userId
	}

	subscribe(listener: (conversationId: string) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(conversationId: string): void {
		for (const listener of Array.from(this.listeners)) {
			try {
				listener(conversationId)
			} catch {
				// a listener's failure must not stop the others
			}
		}
	}

	private id(conversationId: string, keyId: string): string {
		return conversationId + "|" + keyId
	}

	hasKey(conversationId: string, keyId: string): boolean {
		return this.keys.has(this.id(conversationId, keyId))
	}

	private async remember(conversationId: string, keyId: string, raw: Bytes, persist: boolean): Promise<CryptoKey> {
		const id = this.id(conversationId, keyId)
		const existing = this.keys.get(id)
		if (existing) return existing
		const key = await kv.importCek(raw)
		this.raws.set(id, raw)
		this.keys.set(id, key)
		if (persist) await this.queueVault(conversationId, keyId, raw)
		return key
	}

	private async queueVault(conversationId: string, keyId: string, raw: Bytes): Promise<void> {
		const sealed = await kv.sealCek(this.session.ak, raw, this.userId, conversationId, keyId)
		this.vaultQueue.push({ scope: "cek", conversationId, keyId, ...sealed })
		if (!this.vaultTimer) this.vaultTimer = background(setTimeout(() => void this.flushVault(), 400))
	}

	async flushVault(): Promise<void> {
		if (this.vaultTimer) clearTimeout(this.vaultTimer)
		this.vaultTimer = null
		while (this.vaultQueue.length > 0) {
			const batch = this.vaultQueue.splice(0, 200)
			try {
				await api.putVault(batch)
			} catch (error) {
				// A key of a chat that is gone meanwhile is simply dropped; anything
				// else is retried with the next write.
				if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 400)) continue
				this.vaultQueue.unshift(...batch)
				this.vaultTimer = background(setTimeout(() => void this.flushVault(), 15000))
				return
			}
		}
	}

	// Every key the vault holds, opened at once: all chats readable right away.
	async preload(): Promise<number> {
		const res = await api.listVault({ scope: "cek" })
		let opened = 0
		for (const item of res.items) {
			if (!item.conversationId || !item.keyId) continue
			if (this.hasKey(item.conversationId, item.keyId)) continue
			try {
				const raw = await kv.openCek(this.session.ak, item, this.userId, item.conversationId, item.keyId)
				await this.remember(item.conversationId, item.keyId, raw, false)
				opened += 1
			} catch {
				// a copy that does not open is ignored; shares may still work
			}
		}
		return opened
	}

	private identityFor(recipientKey: string | null): Identity[] {
		const all = this.session.identities
		if (recipientKey) {
			const exact = all.filter((identity) => identity.publicKey === recipientKey)
			if (exact.length > 0) return exact
		}
		// Unknown recipient (first-generation copies): current identity first.
		const current = all.filter((identity) => identity.publicKey === this.session.publicKey)
		return current.concat(all.filter((identity) => identity.publicKey !== this.session.publicKey))
	}

	private async openShare(conversationId: string, share: ShareInfo, check: string | null): Promise<Bytes | null> {
		for (const identity of this.identityFor(share.recipientKey)) {
			try {
				const raw = await kv.unwrapShare(identity.privateKey, conversationId, share.keyId, share)
				if (await kv.verifyCek(raw, conversationId, share.keyId, check)) return raw
			} catch {
				// try the next identity
			}
		}
		return null
	}

	// A copy that opens with none of this account's identities (wrapped for a
	// key that is gone, or simply broken) is dropped so another member sends a
	// fresh one. The server keeps it if it is the only copy anywhere.
	private async rejectShare(conversationId: string, keyId: string): Promise<void> {
		const id = this.id(conversationId, keyId)
		if (this.rejected.has(id)) return
		this.rejected.add(id)
		try {
			await api.rejectShare(conversationId, keyId)
		} catch {
			// kept by the server (only copy) or offline: nothing else to do
		}
	}

	async load(conversationId: string, force = false): Promise<ConvState> {
		const cached = this.states.get(conversationId)
		if (!force && cached && Date.now() - cached.loadedAt < STATE_TTL_MS) return cached
		const inflight = this.loading.get(conversationId)
		if (inflight) return inflight
		const run = (async () => {
			const res = await api.conversationKeys(conversationId)
			const epochs = new Map<string, KeyEpochInfo>()
			for (const epoch of res.epochs) epochs.set(epoch.keyId, epoch)
			for (const item of res.vault) {
				if (!item.keyId || this.hasKey(conversationId, item.keyId)) continue
				try {
					const raw = await kv.openCek(this.session.ak, item, this.userId, conversationId, item.keyId)
					await this.remember(conversationId, item.keyId, raw, false)
				} catch {
					// fall back to the shares below
				}
			}
			for (const share of res.shares) {
				if (this.hasKey(conversationId, share.keyId)) continue
				const epoch = epochs.get(share.keyId)
				const raw = await this.openShare(conversationId, share, epoch ? epoch.check : null)
				if (raw) await this.remember(conversationId, share.keyId, raw, true)
				else await this.rejectShare(conversationId, share.keyId)
			}
			const state: ConvState = { currentKeyId: res.currentKeyId, rekeyNeeded: res.rekeyNeeded, epochs, loadedAt: Date.now() }
			this.states.set(conversationId, state)
			if (res.missing.length > 0) void this.shareMissing(conversationId, res.missing)
			return state
		})()
		this.loading.set(conversationId, run)
		try {
			const state = await run
			this.emit(conversationId)
			return state
		} finally {
			this.loading.delete(conversationId)
		}
	}

	// Whether new messages can be sealed now, without creating anything.
	status(conversationId: string): "ready" | "pending" | "unknown" {
		const state = this.states.get(conversationId)
		if (!state) return "unknown"
		if (!state.currentKeyId || state.rekeyNeeded) return "ready"
		return this.hasKey(conversationId, state.currentKeyId) ? "ready" : "pending"
	}

	async keyFor(conversationId: string, keyId: string): Promise<CryptoKey> {
		const id = this.id(conversationId, keyId)
		const known = this.keys.get(id)
		if (known) return known
		const missed = this.lastMiss.get(id) ?? 0
		if (Date.now() - missed > RETRY_MISSING_MS) {
			this.lastMiss.set(id, Date.now())
			await this.load(conversationId, true)
			const loaded = this.keys.get(id)
			if (loaded) return loaded
		}
		throw new KeyUnavailableError(conversationId, keyId)
	}

	async decrypt(conversationId: string, ciphertext: string): Promise<string> {
		const envelope = kv.parseEnvelope(ciphertext)
		if (!envelope) return ciphertext
		const keyId = envelope.version === 1 ? "legacy" : envelope.keyId
		const key = await this.keyFor(conversationId, keyId)
		return kv.openMessage(key, conversationId, envelope)
	}

	// Decrypts without asking the server again: for lists that re-render often.
	async decryptCached(conversationId: string, ciphertext: string): Promise<string> {
		const envelope = kv.parseEnvelope(ciphertext)
		if (!envelope) return ciphertext
		const keyId = envelope.version === 1 ? "legacy" : envelope.keyId
		const key = this.keys.get(this.id(conversationId, keyId))
		if (!key) throw new KeyUnavailableError(conversationId, keyId)
		return kv.openMessage(key, conversationId, envelope)
	}

	async encrypt(conversationId: string, plaintext: string): Promise<string> {
		const { keyId, key } = await this.currentKey(conversationId)
		return kv.sealMessage(key, conversationId, keyId, plaintext)
	}

	// Seals and sends in one step. The server refuses a message sealed with a
	// key that is no longer current (somebody left, or switched keys a moment
	// ago); then the key state is refreshed and the message sealed again.
	async sealAndSend<T>(conversationId: string, plaintext: string, send: (ciphertext: string) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt += 1) {
			const ciphertext = await this.encrypt(conversationId, plaintext)
			try {
				return await send(ciphertext)
			} catch (error) {
				if (attempt >= 2 || !isKeyChanged(error)) throw error
				await this.load(conversationId, true)
			}
		}
	}

	// The key new messages are sealed with. A chat without one (or one that has
	// to re-key because somebody left) gets a new key; older keys stay.
	async currentKey(conversationId: string): Promise<{ keyId: string; key: CryptoKey }> {
		let state = await this.load(conversationId)
		if (state.currentKeyId && !state.rekeyNeeded) {
			const known = this.keys.get(this.id(conversationId, state.currentKeyId))
			if (known) return { keyId: state.currentKeyId, key: known }
			state = await this.load(conversationId, true)
			const again = state.currentKeyId ? this.keys.get(this.id(conversationId, state.currentKeyId)) : null
			if (again && state.currentKeyId && !state.rekeyNeeded) return { keyId: state.currentKeyId, key: again }
			if (state.currentKeyId && !state.rekeyNeeded) throw new KeyUnavailableError(conversationId, state.currentKeyId)
		}
		return this.mint(conversationId)
	}

	// A new key for the chat, wrapped for every member. Older keys are kept,
	// so this never costs anybody the history. Also what a moderator uses when
	// the current key cannot be obtained.
	mint(conversationId: string): Promise<{ keyId: string; key: CryptoKey }> {
		const inflight = this.minting.get(conversationId)
		if (inflight) return inflight
		const run = this.mintNow(conversationId)
		this.minting.set(conversationId, run)
		return run.finally(() => this.minting.delete(conversationId))
	}

	private async mintNow(conversationId: string): Promise<{ keyId: string; key: CryptoKey }> {
		let expected = this.states.get(conversationId)?.currentKeyId ?? null
		const raw = kv.newConversationKey()
		const keyId = kv.newKeyId()
		const check = await kv.cekCheck(raw, conversationId, keyId)
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const members = (await api.getConversationMembers(conversationId)).members
			const shares: ShareInput[] = []
			for (const member of members) {
				if (!member.publicKey) continue
				const wrapped = await kv.wrapShare(member.publicKey, conversationId, keyId, raw)
				shares.push({ memberId: member.userId, recipientKey: member.publicKey, ...wrapped })
			}
			if (!shares.some((share) => share.memberId === this.userId)) throw new Error("this account has no published identity key")
			try {
				await api.createKeyEpoch(conversationId, { keyId, expectedCurrentKeyId: expected, check, shares })
				const key = await this.remember(conversationId, keyId, raw, true)
				const state = this.states.get(conversationId)
				if (state) {
					state.currentKeyId = keyId
					state.rekeyNeeded = false
					state.epochs.set(keyId, { keyId, createdBy: this.userId, createdAt: new Date().toISOString(), check })
				}
				void this.flushVault()
				this.emit(conversationId)
				return { keyId, key }
			} catch (error) {
				if (!(error instanceof ApiError) || error.status !== 409) throw error
				const data = (error as ApiError & { data?: { currentKeyId?: string | null } }).data
				if (data && "currentKeyId" in data) {
					// Somebody else switched the key first: use theirs if it is usable.
					const state = await this.load(conversationId, true)
					if (state.currentKeyId && !state.rekeyNeeded) {
						const theirs = this.keys.get(this.id(conversationId, state.currentKeyId))
						if (theirs) return { keyId: state.currentKeyId, key: theirs }
					}
					expected = state.currentKeyId
				}
				// Otherwise a member's identity changed meanwhile: wrap again.
			}
		}
		throw new KeyUnavailableError(conversationId, null)
	}

	// Hands the keys this account holds to members that lack them.
	private async shareMissing(conversationId: string, missing: MissingShare[]): Promise<void> {
		const shares: ShareInput[] = []
		for (const item of missing) {
			const raw = this.raws.get(this.id(conversationId, item.keyId))
			if (!raw || !item.publicKey) continue
			try {
				const wrapped = await kv.wrapShare(item.publicKey, conversationId, item.keyId, raw)
				shares.push({ keyId: item.keyId, memberId: item.memberId, recipientKey: item.publicKey, ...wrapped })
			} catch {
				// a malformed member key: skip it
			}
		}
		for (let i = 0; i < shares.length; i += 200) {
			try {
				await api.putShares(conversationId, shares.slice(i, i + 200))
			} catch {
				// retried on the next sweep
			}
		}
	}

	// Sweep across all chats: every key somebody lacks and this account holds
	// is handed over. Runs at start, on request and every few minutes.
	async syncPending(): Promise<void> {
		if (this.syncing) return
		this.syncing = true
		try {
			const res = await api.listPendingShares()
			const byConversation = new Map<string, MissingShare[]>()
			for (const item of res.missing) {
				const list = byConversation.get(item.conversationId) ?? []
				list.push(item)
				byConversation.set(item.conversationId, list)
			}
			for (const [conversationId, list] of byConversation) {
				if (list.some((item) => !this.raws.has(this.id(conversationId, item.keyId)))) {
					try {
						await this.load(conversationId, true)
					} catch {
						// share what is known
					}
				}
				await this.shareMissing(conversationId, list)
			}
		} finally {
			this.syncing = false
		}
	}

	// Moves every copy addressed to this account into the vault, once, so a
	// later change of identity can never make those keys unreachable.
	async migrateShares(): Promise<number> {
		const res = await api.listMyShares()
		let moved = 0
		for (const share of res.shares) {
			if (this.hasKey(share.conversationId, share.keyId)) continue
			const raw = await this.openShare(share.conversationId, share, null)
			if (!raw) continue
			await this.remember(share.conversationId, share.keyId, raw, true)
			moved += 1
			this.emit(share.conversationId)
		}
		await this.flushVault()
		return moved
	}

	// --- realtime hooks -------------------------------------------------------

	onEpochCreated(conversationId: string, keyId: string): void {
		const state = this.states.get(conversationId)
		if (state) {
			state.currentKeyId = keyId
			state.rekeyNeeded = false
			state.loadedAt = 0
		}
		if (!this.hasKey(conversationId, keyId)) void this.load(conversationId, true).catch(() => undefined)
	}

	onSharesAdded(conversationId: string): void {
		this.lastMiss.clear()
		void this.load(conversationId, true).catch(() => undefined)
	}

	onSharesNeeded(conversationId: string): void {
		void this.load(conversationId, true).catch(() => undefined)
	}

	onMembershipChanged(conversationId: string): void {
		const state = this.states.get(conversationId)
		if (state) state.loadedAt = 0
		void this.load(conversationId, true).catch(() => undefined)
	}
}

export function isKeyChanged(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && error.message === "conversation key changed"
}

let active: Keyring | null = null

export function setActiveKeyring(keyring: Keyring | null): void {
	active = keyring
}

export function activeKeyring(): Keyring | null {
	return active
}
