// In-app notifications: cards in the corner that disappear after 5 seconds.
let openHandler: ((conversationId: string) => void) | null = null
const TTL_MS = 5000
const MAX_CARDS = 4

export function setToastOpenHandler(fn: ((conversationId: string) => void) | null): void {
	openHandler = fn
}

function host(): HTMLElement | null {
	if (typeof document === "undefined") return null
	let node = document.getElementById("fx-toast-host")
	if (!node) {
		node = document.createElement("div")
		node.id = "fx-toast-host"
		node.className = "toast-host"
		node.setAttribute("aria-live", "polite")
		document.body.appendChild(node)
	}
	return node
}
function remove(card: HTMLElement): void {
	if (!card.parentElement) return
	card.classList.add("fx-out")
	window.setTimeout(() => card.remove(), 220)
}

export function pushToast(input: { title: string; body: string; conversationId?: string | null }): void {
	if (!appFocused() && systemNotify(input)) return
	const root = host()
	if (!root) return
	const card = document.createElement("div")
	card.className = "toast"
	const head = document.createElement("div")
	head.className = "toast-title"
	head.textContent = input.title
	const body = document.createElement("div")
	body.className = "toast-body"
	body.textContent = input.body
	card.appendChild(head)
	card.appendChild(body)
	const target = input.conversationId ?? null
	card.addEventListener("click", () => {
		if (target && openHandler) openHandler(target)
		remove(card)
	})
	root.appendChild(card)
	while (root.childElementCount > MAX_CARDS) {
		const first = root.firstElementChild
		if (!first) break
		first.remove()
	}
	window.setTimeout(() => remove(card), TTL_MS)
}

type NativeBridge = {
	notify?: (title: string, body: string, tag: string) => void
	isFocused?: () => boolean
	platform?: string
}

function native(): NativeBridge | null {
	if (typeof window === "undefined") return null
	const w = window as any
	const bridge = w.FrontierXNative
	if (bridge && typeof bridge.notify === "function") return bridge as NativeBridge
	return null
}

export function ensureNotificationPermission(): void {
	if (native()) return
	if (typeof Notification === "undefined") return
	if (Notification.permission !== "default") return
	try { void Notification.requestPermission() } catch { }
}

function appFocused(): boolean {
	// Native shells report real window state. Chromium's own focus tracking is
	// unreliable inside the desktop shell, which suppressed system
	// notifications there while the browser build worked fine.
	const bridge = native()
	if (bridge && typeof bridge.isFocused === "function") {
		try {
			return bridge.isFocused()
		} catch {
			// fall through to the DOM checks below
		}
	}
	if (typeof document === "undefined") return true
	if (document.hidden) return false
	if (typeof document.hasFocus === "function") return document.hasFocus()
	return true
}
export function systemNotify(input: { title: string; body: string; conversationId?: string | null }): boolean {
	const tag = input.conversationId ?? "frontierx"
	const bridge = native()
	if (bridge && bridge.notify) {
		try {
			bridge.notify(input.title, input.body, tag)
			return true
		} catch { return false }
	}
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return false
	try {
		const note = new Notification(input.title, { body: input.body, tag })
		note.onclick = () => {
			try { window.focus() } catch { }
			if (input.conversationId && openHandler) openHandler(input.conversationId)
			note.close()
		}
		return true
	} catch { return false }
}

if (typeof window !== "undefined") {
	const arm = () => {
		ensureNotificationPermission()
		window.removeEventListener("pointerdown", arm)
		window.removeEventListener("keydown", arm)
	}
	window.addEventListener("pointerdown", arm)
	window.addEventListener("keydown", arm)

	// Clicks on native notifications are relayed by the desktop shell as window
	// messages, so the conversation can be opened from the notification itself.
	window.addEventListener("message", (event: MessageEvent) => {
		if (event.source !== window) return
		const data = event.data as { type?: unknown; tag?: unknown } | null
		if (!data || data.type !== "frontierx:notification-click") return
		const tag = typeof data.tag === "string" ? data.tag : ""
		if (!tag || tag === "frontierx") return
		if (openHandler) openHandler(tag)
	})
}