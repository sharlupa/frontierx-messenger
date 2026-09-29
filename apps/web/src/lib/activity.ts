import { isAndroidApp } from "./native"

// Whether the person is actually looking at FrontierX. Others see "online"
// only then, not while the tab sits in the background.
//
// - Browser and desktop: the page is visible and its window has focus. The
//   desktop shell keeps pages "visible" while hidden in the tray, so its own
//   focus report (window.FrontierXNative.isFocused) is taken into account too.
// - Android: the activity reports being in front through window.fxSetPresence
//   (onResume / onPause), because WebView focus does not follow the screen.
//
// Stepping away counts after a short grace period, so a quick look at another
// tab does not flicker the status; coming back counts at once. On Android the
// signal from the system is final and applies immediately — timers of a
// backgrounded WebView may not run at all.

const AWAY_DELAY_MS = 5000
const RECHECK_MS = 5000

export type ActivityWatcher = {
	active: () => boolean
	// The native layer's say (Android onResume/onPause); true by default.
	setNativeInFront: (inFront: boolean) => void
	stop: () => void
}

export function watchActivity(onChange: (active: boolean) => void): ActivityWatcher {
	const android = isAndroidApp()
	let nativeInFront = true

	const shellFocused = (): boolean => {
		const bridge = (globalThis as unknown as { FrontierXNative?: { isFocused?: () => boolean } }).FrontierXNative
		if (!bridge || typeof bridge.isFocused !== "function") return true
		try {
			return bridge.isFocused() !== false
		} catch {
			return true
		}
	}

	const lookingNow = (): boolean => {
		if (typeof document === "undefined") return true
		if (document.visibilityState === "hidden") return false
		if (android) return nativeInFront
		const pageFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true
		return pageFocused && shellFocused()
	}

	let reported = lookingNow()
	let awayTimer: ReturnType<typeof setTimeout> | null = null

	const report = (next: boolean) => {
		if (reported === next) return
		reported = next
		onChange(next)
	}

	const evaluate = () => {
		if (lookingNow()) {
			if (awayTimer) {
				clearTimeout(awayTimer)
				awayTimer = null
			}
			report(true)
			return
		}
		if (!reported || awayTimer) return
		if (android && !nativeInFront) {
			report(false)
			return
		}
		awayTimer = setTimeout(() => {
			awayTimer = null
			if (!lookingNow()) report(false)
		}, AWAY_DELAY_MS)
	}

	const windowEvents = ["focus", "blur", "pageshow", "pagehide"] as const
	document.addEventListener("visibilitychange", evaluate)
	for (const name of windowEvents) window.addEventListener(name, evaluate)
	// Focus changes do not always produce events (for example the desktop
	// shell hiding its window), so the state is re-checked now and then.
	const recheck = setInterval(evaluate, RECHECK_MS)

	return {
		active: () => reported,
		setNativeInFront(inFront: boolean) {
			nativeInFront = inFront
			evaluate()
		},
		stop() {
			document.removeEventListener("visibilitychange", evaluate)
			for (const name of windowEvents) window.removeEventListener(name, evaluate)
			clearInterval(recheck)
			if (awayTimer) clearTimeout(awayTimer)
			awayTimer = null
		},
	}
}
