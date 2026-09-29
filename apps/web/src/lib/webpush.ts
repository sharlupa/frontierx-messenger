import { api } from "./api"
import { getDeviceId, listAccounts } from "./session"
import { isNativeApp, nativePlatform } from "./native"

// Background notifications through the browser's own push service: Chrome,
// Firefox, Edge, Safari on macOS and installed web apps on iPhone and iPad
// (iOS 16.4 and later, after "Add to Home Screen"). One subscription serves
// every account signed in on this device; each account registers it.

export type PushSupport = "supported" | "unsupported" | "needs-install" | "native" | "ios-app"

function isIos(): boolean {
	if (typeof navigator === "undefined") return false
	const ua = navigator.userAgent
	return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1)
}

export function isStandalone(): boolean {
	if (typeof window === "undefined") return false
	const nav = navigator as Navigator & { standalone?: boolean }
	return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
}

export function webPushSupport(): PushSupport {
	// The iPhone app cannot receive pushes with the app closed (that needs
	// Apple's push service); the web app installed from Safari can.
	if (nativePlatform() === "ios") return "ios-app"
	if (isNativeApp()) return "native"
	if (typeof window === "undefined" || !("serviceWorker" in navigator)) return isIos() ? "needs-install" : "unsupported"
	if (!("PushManager" in window) || typeof Notification === "undefined") return isIos() && !isStandalone() ? "needs-install" : "unsupported"
	return "supported"
}

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
	const binary = atob(padded)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
	return out
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
	try {
		return await Promise.race([
			navigator.serviceWorker.ready,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
		])
	} catch {
		return null
	}
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	if (webPushSupport() !== "supported") return null
	const reg = await registration()
	if (!reg) return null
	try {
		return await reg.pushManager.getSubscription()
	} catch {
		return null
	}
}

function subscriptionBody(subscription: PushSubscription): { endpoint: string; p256dh: string; auth: string; deviceId: string } | null {
	const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
	if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null
	return { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, deviceId: getDeviceId() }
}

// Every signed-in account on this device gets notified through the one
// subscription, so notifications arrive whichever account is open.
async function registerForAccounts(subscription: PushSubscription): Promise<void> {
	const body = subscriptionBody(subscription)
	if (!body) return
	for (const account of listAccounts()) {
		if (!account.token) continue
		try {
			await api.registerWebPush(body, account.token)
		} catch {
			// that account's session is gone; it registers after its next sign-in
		}
	}
}

// Must run from a click (Safari and iOS insist on a user gesture).
export async function enableWebPush(): Promise<boolean> {
	if (webPushSupport() !== "supported") return false
	const permission = await Notification.requestPermission()
	if (permission !== "granted") return false
	const reg = await registration()
	if (!reg) return false
	let subscription = await reg.pushManager.getSubscription()
	if (!subscription) {
		const { publicKey } = await api.vapidKey()
		subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) })
	}
	await registerForAccounts(subscription)
	return true
}

export async function disableWebPush(): Promise<void> {
	const subscription = await currentSubscription()
	if (!subscription) return
	for (const account of listAccounts()) {
		if (!account.token) continue
		try {
			await api.unregisterWebPush(subscription.endpoint, account.token)
		} catch {
			// best effort
		}
	}
	try {
		await subscription.unsubscribe()
	} catch {
		// already gone
	}
}

// At start: an existing subscription is (re)registered for every account, so
// an account added later gets notifications without visiting the settings.
export async function syncWebPush(): Promise<void> {
	if (webPushSupport() !== "supported" || Notification.permission !== "granted") return
	const subscription = await currentSubscription()
	if (subscription) await registerForAccounts(subscription)
}

// Removes this device's subscription from one account (signing it out).
export async function unregisterWebPushFor(token: string): Promise<void> {
	const subscription = await currentSubscription()
	if (!subscription) return
	try {
		await api.unregisterWebPush(subscription.endpoint, token)
	} catch {
		// best effort
	}
}
