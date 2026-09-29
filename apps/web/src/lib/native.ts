type NativeBridge = {
	platform?: unknown
	setAuthToken?: (token: string) => void
	clearAuthToken?: () => void
	pushEnabled?: () => boolean
	checkUpdates?: () => void
	notify?: (title: string, body: string, conversationId?: string) => void
	isFocused?: () => boolean
}

function bridge(): NativeBridge | null {
	const holder = globalThis as unknown as { FrontierXNative?: NativeBridge }
	const native = holder.FrontierXNative
	return native && typeof native === "object" ? native : null
}

export function nativePlatform(): string | null {
	const native = bridge()
	if (!native) return null
	try {
		if (typeof native.platform === "function") {
			const value = (native.platform as () => unknown)()
			return typeof value === "string" && value ? value : null
		}
		if (typeof native.platform === "string" && native.platform) return native.platform
	} catch {
		return null
	}
	return null
}

export function isNativeApp(): boolean {
	return nativePlatform() !== null
}

export function isAndroidApp(): boolean {
	return nativePlatform() === "android"
}

export function nativeSetAuthToken(token: string): void {
	const native = bridge()
	if (!native || typeof native.setAuthToken !== "function" || !token) return
	try {
		native.setAuthToken(token)
	} catch {
		/* native bridge unavailable */
	}
}

export function nativeClearAuthToken(): void {
	const native = bridge()
	if (!native || typeof native.clearAuthToken !== "function") return
	try {
		native.clearAuthToken()
	} catch {
		/* native bridge unavailable */
	}
}

export function nativePushSupported(): boolean {
	const native = bridge()
	if (!native || typeof native.pushEnabled !== "function") return false
	try {
		return native.pushEnabled() === true
	} catch {
		return false
	}
}

export function nativeCheckUpdates(): boolean {
	const native = bridge()
	if (!native || typeof native.checkUpdates !== "function") return false
	try {
		native.checkUpdates()
		return true
	} catch {
		return false
	}
}

export const OPEN_CONVERSATION_EVENT = "frontierx:open-conversation"

export type OpenConversationDetail = { conversationId: string }

export function onOpenConversation(handler: (conversationId: string) => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<OpenConversationDetail>).detail
		const id = detail && typeof detail.conversationId === "string" ? detail.conversationId.trim() : ""
		if (id) handler(id)
	}
	window.addEventListener(OPEN_CONVERSATION_EVENT, listener as EventListener)
	return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, listener as EventListener)
}