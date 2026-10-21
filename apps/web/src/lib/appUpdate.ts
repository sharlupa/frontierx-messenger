// Keeping the app current without anyone reaching for Ctrl+F5.
//
// The service worker serves the app's page from the network when there is
// one (public/push-sw.js), so every start already runs the latest build. An
// app that stays open (a tab left for days, the Android app kept in memory)
// checks now and then whether a newer build is out, and restarts into it at
// a moment nobody notices: while it is in the background, or right after it
// started or came back, before it was touched. Never during a call, an upload
// or a voice recording.

const CHECK_EVERY_MS = 30 * 60 * 1000
// Checks when the app comes back are at most this frequent.
const RECHECK_ON_RETURN_MS = 5 * 60 * 1000
// Found this soon after a start or a return, with no touch yet: restart now.
const QUIET_WINDOW_MS = 12000
const REOPEN_KEY = "fx.reopen"

let stale = false
let holds = 0
let lastTouch = 0
let quietSince = Date.now()
let lastCheck = 0
let nativeAway = false
let registration: ServiceWorkerRegistration | null = null
const beforeRestart = new Set<() => void>()

// The entry script this page runs, from the build's hashed file name.
function runningEntry(): string | null {
	if (typeof document === "undefined") return null
	const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
	if (!script) return null
	const match = /\/assets\/index-[^/]+\.js/.exec(script.src)
	return match ? match[0] : null
}

export function latestEntryOf(html: string): string | null {
	const match = /\/assets\/index-[^"'/]+\.js/.exec(html)
	return match ? match[0] : null
}

// The page as the server has it now. The query keeps it out of the service
// worker's copies, so the answer is really the server's.
async function newestEntry(): Promise<string | null> {
	const res = await fetch("/?app=1&build=" + Date.now(), { cache: "no-store", credentials: "same-origin" })
	if (!res.ok) return null
	return latestEntryOf(await res.text())
}

async function check(): Promise<void> {
	if (stale) return
	lastCheck = Date.now()
	void registration?.update().catch(() => undefined)
	const running = runningEntry()
	if (!running) return
	try {
		const newest = await newestEntry()
		if (newest && newest !== running) {
			stale = true
			restartIfQuiet()
		}
	} catch {
		// offline: next time
	}
}

function hidden(): boolean {
	return nativeAway || (typeof document !== "undefined" && document.visibilityState === "hidden")
}

function restartIfQuiet(): void {
	if (!stale || holds > 0) return
	const untouched = lastTouch < quietSince && Date.now() - quietSince < QUIET_WINDOW_MS
	if (!hidden() && !untouched) return
	for (const hook of Array.from(beforeRestart)) {
		try {
			hook()
		} catch {
			// a hook's failure must not keep the old build running
		}
	}
	window.location.reload()
}

function cameBack(): void {
	quietSince = Date.now()
	if (stale) restartIfQuiet()
	else if (Date.now() - lastCheck > RECHECK_ON_RETURN_MS) void check()
}

// While something must not be cut short (a call, an upload, a recording).
export function holdUpdates(): () => void {
	holds += 1
	let released = false
	return () => {
		if (released) return
		released = true
		holds -= 1
		restartIfQuiet()
	}
}

// Called right before the restart, to keep what the person was looking at.
export function onBeforeRestart(hook: () => void): () => void {
	beforeRestart.add(hook)
	return () => beforeRestart.delete(hook)
}

// The chat that was open before an update restart, once.
export function takeReopenedChat(): string | null {
	try {
		const id = sessionStorage.getItem(REOPEN_KEY)
		if (id) sessionStorage.removeItem(REOPEN_KEY)
		return id
	} catch {
		return null
	}
}

export function rememberOpenChat(conversationId: string | null): void {
	try {
		if (conversationId) sessionStorage.setItem(REOPEN_KEY, conversationId)
		else sessionStorage.removeItem(REOPEN_KEY)
	} catch {
		// the first chat opens instead
	}
}

// The Android activity says when it goes to the background (ws.ts relays it).
export const NATIVE_PRESENCE_EVENT = "frontierx:native-presence"

export function startAppUpdates(): void {
	if (typeof window === "undefined") return
	if ("serviceWorker" in navigator) {
		window.addEventListener("load", () => {
			navigator.serviceWorker
				.register("/sw.js", { scope: "/", updateViaCache: "none" })
				.then((value) => {
					registration = value
				})
				.catch(() => undefined)
		})
	}
	const touch = () => {
		lastTouch = Date.now()
	}
	window.addEventListener("pointerdown", touch, { capture: true, passive: true })
	window.addEventListener("keydown", touch, { capture: true })
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") restartIfQuiet()
		else cameBack()
	})
	window.addEventListener(NATIVE_PRESENCE_EVENT, (event) => {
		const visible = (event as CustomEvent<{ visible: boolean }>).detail?.visible !== false
		nativeAway = !visible
		if (visible) cameBack()
		else restartIfQuiet()
	})
	window.addEventListener("online", () => void check())
	window.setTimeout(() => void check(), 4000)
	window.setInterval(() => {
		if (stale) restartIfQuiet()
		else void check()
	}, CHECK_EVERY_MS)
}
