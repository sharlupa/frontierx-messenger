import { nativePlatform } from "./native"
import { isStandalone } from "./webpush"

// Where the app runs: one of the native shells, an installed web app, or a
// plain browser tab.
export type PlatformKind = "android" | "ios" | "macos" | "windows" | "linux" | "webapp" | "browser"

export function platformKind(): PlatformKind {
	const native = nativePlatform()
	if (native === "android") return "android"
	if (native === "ios") return "ios"
	if (native === "desktop") return /Mac/i.test(navigator.userAgent) ? "macos" : /Windows/i.test(navigator.userAgent) ? "windows" : "linux"
	return isStandalone() ? "webapp" : "browser"
}
