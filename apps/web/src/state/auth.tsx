import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { User } from "../lib/types"
import { api, UNAUTHORIZED_EVENT } from "../lib/api"
import {
	getActiveAccount,
	getActiveAccountId,
	getDeviceId,
	getStoredUser,
	getToken,
	listAccounts,
	markSignedOut,
	removeAccount,
	setActiveAccountId,
	setSession,
	updateStoredUser,
	type StoredAccount,
} from "../lib/session"
import { nativeClearAuthToken, nativeSetAuthToken } from "../lib/native"
import * as kv from "../lib/keyvault"
import { addIdentities, forgetAccountKeys, loadAccountKey } from "../lib/keystore"
import { Keyring, setActiveKeyring, type KeySession } from "../lib/keyring"
import {
	addPasswordSlot,
	changePassword as changeAccountPassword,
	createRecoveryKey as createAccountRecoveryKey,
	keyHealth,
	setupKeys,
	startLink as startLinkAttempt,
	startOver as startOverKeys,
	unlockWithPassword,
	unlockWithRecoveryKey,
	type KeyHealth,
	type KeySetup,
	type LinkAttempt,
	type LockedInfo,
} from "../lib/accountKeys"

export type KeysState =
	| { status: "loading" }
	| { status: "ready"; session: KeySession; health: KeyHealth }
	| { status: "locked"; info: LockedInfo }
	| { status: "error"; message: string }

type AuthContextValue = {
	user: User | null
	token: string | null
	initializing: boolean
	accounts: StoredAccount[]
	keys: KeysState
	keyring: Keyring | null
	login: (username: string, password: string, options?: { add?: boolean }) => Promise<void>
	register: (username: string, password: string, displayName: string, email?: string, options?: { add?: boolean }) => Promise<{ emailPending: string | null; emailSent: boolean; emailError: string | null }>
	updateUser: (user: User) => void
	logout: () => void
	removeAccountFromDevice: (accountId: string) => void
	switchAccount: (accountId: string) => void
	unlockWithPassword: (secret: string, previous: boolean) => Promise<void>
	unlockWithRecovery: (code: string) => Promise<void>
	startLink: () => Promise<LinkAttempt>
	finishLink: (attempt: LinkAttempt, signal: { cancelled: boolean }) => Promise<void>
	startOver: (password: string) => Promise<void>
	createRecoveryKey: () => Promise<string>
	changePassword: (current: string, next: string, signOutOthers: boolean) => Promise<void>
	sealWithPassword: (password: string) => Promise<void>
	refreshKeyHealth: () => Promise<void>
	// Checks the device's key against the server again (after the account's
	// keys were replaced elsewhere) and re-runs setup when it no longer fits.
	revalidateKeys: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// The password typed at sign-in stays in memory (never storage) for a few
// minutes, so a device that had to be unlocked another way can still seal the
// keys with it afterwards.
const PASSWORD_MEMORY_MS = 10 * 60 * 1000

function deviceLabel(): string {
	const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
	if (/iPhone|iPad|iPod/.test(ua)) return "iPhone / iPad"
	if (/Android/.test(ua)) return "Android"
	if (/Macintosh/.test(ua)) return "Mac"
	if (/Windows/.test(ua)) return "Windows"
	if (/Linux/.test(ua)) return "Linux"
	return "Browser"
}

// Everything of one account lives in module state (keys, caches, sockets), so
// changing the active account starts the app afresh.
function reloadApp(): void {
	window.location.assign("/")
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(() => getStoredUser())
	const [token, setToken] = useState<string | null>(() => getToken())
	const [initializing, setInitializing] = useState(true)
	const [accounts, setAccounts] = useState<StoredAccount[]>(() => listAccounts())
	const [keys, setKeys] = useState<KeysState>({ status: "loading" })
	const [keyring, setKeyring] = useState<Keyring | null>(null)
	const passwordRef = useRef<{ value: string; until: number } | null>(null)
	const userRef = useRef<User | null>(user)
	userRef.current = user

	const rememberedPassword = (): string | null => {
		const held = passwordRef.current
		if (!held || Date.now() > held.until) {
			passwordRef.current = null
			return null
		}
		return held.value
	}

	const refreshAccounts = useCallback(() => setAccounts(listAccounts()), [])

	// Keys are ready: build the keyring, open the vault and hand over keys
	// other members are waiting for.
	const applySetup = useCallback((setup: KeySetup) => {
		if (setup.status === "locked") {
			setActiveKeyring(null)
			setKeyring(null)
			setKeys({ status: "locked", info: setup.info })
			return
		}
		passwordRef.current = null
		const ring = new Keyring(setup.session)
		setActiveKeyring(ring)
		setKeyring(ring)
		setKeys({ status: "ready", session: setup.session, health: setup.health })
		void (async () => {
			try {
				await ring.preload()
				await ring.migrateShares()
				await ring.syncPending()
			} catch {
				// the chat still works key by key; the sweep repeats later
			}
		})()
	}, [])

	const runSetup = useCallback(async (userId: string, password: string | null) => {
		setKeys({ status: "loading" })
		try {
			applySetup(await setupKeys(userId, password))
		} catch (error) {
			setKeys({ status: "error", message: error instanceof Error ? error.message : "key setup failed" })
		}
	}, [applySetup])

	useEffect(() => {
		let active = true
		if (!getToken()) {
			setInitializing(false)
			return
		}
		api
			.me()
			.then((res) => {
				if (!active) return
				setUser(res.user)
				updateStoredUser(res.user)
				refreshAccounts()
				const stored = getToken()
				if (stored) nativeSetAuthToken(stored)
				void runSetup(res.user.id, null)
			})
			.catch((error) => {
				if (!active) return
				// Offline: keep the stored account and try again when the line is back.
				if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 401) {
					const id = getActiveAccountId()
					if (id) markSignedOut(id)
					nativeClearAuthToken()
					setUser(null)
					setToken(null)
					refreshAccounts()
				} else if (getStoredUser()) {
					const stored = getStoredUser() as User
					setUser(stored)
					void runSetup(stored.id, null)
				}
			})
			.finally(() => {
				if (active) setInitializing(false)
			})
		return () => {
			active = false
		}
	}, [runSetup, refreshAccounts])

	// Any request answered 401 ends this account's session on this device; the
	// account and its keys stay, so signing in again is enough.
	useEffect(() => {
		const onUnauthorized = (event: Event) => {
			const detail = (event as CustomEvent<{ token: string }>).detail
			if (!detail || detail.token !== getToken()) return
			const id = getActiveAccountId()
			if (id) markSignedOut(id)
			nativeClearAuthToken()
			setActiveKeyring(null)
			setKeyring(null)
			setUser(null)
			setToken(null)
			refreshAccounts()
		}
		window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
		return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
	}, [refreshAccounts])

	const login = useCallback(async (username: string, password: string, options: { add?: boolean } = {}) => {
		const previous = getActiveAccountId()
		const res = await api.login({ username, password, deviceId: getDeviceId() })
		setSession(res.token, res.user)
		refreshAccounts()
		nativeSetAuthToken(res.token)
		if (options.add && previous && previous !== res.user.id) {
			// A second account: its keys are set up now (while the password is
			// known), then the app restarts in it.
			try {
				await setupKeys(res.user.id, password)
			} catch {
				// unlocked after the restart instead
			}
			reloadApp()
			return
		}
		passwordRef.current = { value: password, until: Date.now() + PASSWORD_MEMORY_MS }
		setToken(res.token)
		setUser(res.user)
		await runSetup(res.user.id, password)
	}, [refreshAccounts, runSetup])

	const register = useCallback(async (username: string, password: string, displayName: string, email?: string, options: { add?: boolean } = {}) => {
		const previous = getActiveAccountId()
		const identity = await kv.generateIdentity()
		const trimmedEmail = email && email.trim() ? email.trim() : undefined
		const res = await api.register({
			username,
			password,
			displayName: displayName || undefined,
			email: trimmedEmail,
			publicKey: identity.publicKey,
			deviceId: getDeviceId(),
		})
		// The identity is kept first; the account key is then created around it.
		addIdentities(res.user.id, [identity])
		setSession(res.token, res.user)
		refreshAccounts()
		nativeSetAuthToken(res.token)
		const outcome = {
			emailPending: res.email ? res.email.pending : null,
			emailSent: res.email ? res.email.sent === true : false,
			emailError: res.email ? res.email.error : null,
		}
		if (options.add && previous && previous !== res.user.id) {
			try {
				await setupKeys(res.user.id, password)
			} catch {
				// set up after the restart
			}
			if (!outcome.emailPending) reloadApp()
			return outcome
		}
		passwordRef.current = { value: password, until: Date.now() + PASSWORD_MEMORY_MS }
		setToken(res.token)
		setUser(res.user)
		await runSetup(res.user.id, password)
		return outcome
	}, [refreshAccounts, runSetup])

	const updateUser = useCallback((nextUser: User) => {
		setUser(nextUser)
		updateStoredUser(nextUser)
		refreshAccounts()
	}, [refreshAccounts])

	const removeAccountFromDevice = useCallback((accountId: string) => {
		const wasActive = accountId === getActiveAccountId()
		forgetAccountKeys(accountId)
		removeAccount(accountId)
		refreshAccounts()
		if (wasActive) {
			nativeClearAuthToken()
			setActiveKeyring(null)
			reloadApp()
		}
	}, [refreshAccounts])

	// Signing out removes the account and its keys from this device; the keys
	// stay safe on the server behind the password (and the recovery key).
	const logout = useCallback(() => {
		const id = getActiveAccountId()
		if (id) removeAccountFromDevice(id)
		else reloadApp()
	}, [removeAccountFromDevice])

	const switchAccount = useCallback((accountId: string) => {
		if (accountId === getActiveAccountId()) return
		if (!listAccounts().some((account) => account.id === accountId)) return
		setActiveAccountId(accountId)
		reloadApp()
	}, [])

	const requireUserId = (): string => {
		const current = userRef.current
		if (!current) throw new Error("not signed in")
		return current.id
	}

	const requireSession = (): KeySession => {
		if (keys.status !== "ready") throw new Error("keys are locked")
		return keys.session
	}

	const unlockPassword = useCallback(async (secret: string, previous: boolean) => {
		const userId = requireUserId()
		const setup = await unlockWithPassword(userId, secret, previous ? rememberedPassword() : secret)
		applySetup(setup)
	}, [applySetup])

	const unlockRecovery = useCallback(async (code: string) => {
		const userId = requireUserId()
		applySetup(await unlockWithRecoveryKey(userId, code, rememberedPassword()))
	}, [applySetup])

	const startLink = useCallback(async () => {
		const userId = requireUserId()
		return startLinkAttempt(userId, deviceLabel(), rememberedPassword())
	}, [])

	const finishLink = useCallback(async (attempt: LinkAttempt, signal: { cancelled: boolean }) => {
		applySetup(await attempt.wait(signal))
	}, [applySetup])

	const startOver = useCallback(async (password: string) => {
		const userId = requireUserId()
		applySetup(await startOverKeys(userId, password))
	}, [applySetup])

	const revalidateKeys = useCallback(async () => {
		const current = userRef.current
		if (!current) return
		try {
			const state = await api.keyState()
			const local = loadAccountKey(current.id)
			if (local && state.accountKey && (await kv.verifyAccountKey(local, current.id, state.accountKey.check))) return
		} catch {
			return
		}
		await runSetup(current.id, null)
	}, [runSetup])

	const refreshKeyHealth = useCallback(async () => {
		const health = await keyHealth()
		setKeys((current) => (current.status === "ready" ? { ...current, health } : current))
	}, [])

	const createRecoveryKey = useCallback(async () => {
		const code = await createAccountRecoveryKey(requireSession())
		await refreshKeyHealth()
		return code
	}, [keys, refreshKeyHealth])

	const changePassword = useCallback(async (current: string, next: string, signOutOthers: boolean) => {
		await changeAccountPassword(requireSession(), current, next, signOutOthers)
		await refreshKeyHealth()
	}, [keys, refreshKeyHealth])

	const sealWithPassword = useCallback(async (password: string) => {
		await addPasswordSlot(requireSession(), password)
		await refreshKeyHealth()
	}, [keys, refreshKeyHealth])

	const value = useMemo<AuthContextValue>(
		() => ({
			user,
			token,
			initializing,
			accounts,
			keys,
			keyring,
			login,
			register,
			updateUser,
			logout,
			removeAccountFromDevice,
			switchAccount,
			unlockWithPassword: unlockPassword,
			unlockWithRecovery: unlockRecovery,
			startLink,
			finishLink,
			startOver,
			createRecoveryKey,
			changePassword,
			sealWithPassword,
			refreshKeyHealth,
			revalidateKeys,
		}),
		[user, token, initializing, accounts, keys, keyring, login, register, updateUser, logout, removeAccountFromDevice, switchAccount, unlockPassword, unlockRecovery, startLink, finishLink, startOver, createRecoveryKey, changePassword, sealWithPassword, refreshKeyHealth, revalidateKeys],
	)

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext)
	if (!ctx) throw new Error("useAuth must be used within AuthProvider")
	return ctx
}

// The signed-out account the sign-in screen should offer (after a session
// ended elsewhere), if any.
export function signedOutAccount(): StoredAccount | null {
	const active = getActiveAccount()
	return active && !active.token ? active : null
}
