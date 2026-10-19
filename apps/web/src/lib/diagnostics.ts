import { APP_BUILD, APP_VERSION } from "./buildInfo"
import { platformKind } from "./platform"

// Technical details a bug report may carry: which build and where it runs,
// plus the last errors the page ran into. Never message contents; the page
// address goes without its query.
export type Diagnostics = {
	version: string
	build: string
	platform: string
	userAgent: string
	language: string
	screen: string
	viewport: string
	timezone: string
	online: string
	page: string
	errors: string[]
}

const ERROR_LOG_SIZE = 10
const ERROR_TEXT_MAX = 300
const errorLog: string[] = []

function remember(text: string): void {
	const line = text.replace(/\s+/g, " ").trim().slice(0, ERROR_TEXT_MAX)
	if (!line) return
	errorLog.push(new Date().toISOString().slice(11, 19) + " " + line)
	if (errorLog.length > ERROR_LOG_SIZE) errorLog.splice(0, errorLog.length - ERROR_LOG_SIZE)
}

function describe(reason: unknown): string {
	if (reason instanceof Error) return reason.name + ": " + reason.message
	return typeof reason === "string" ? reason : String(reason)
}

let installed = false
// Called once at start-up.
export function installErrorLog(): void {
	if (installed || typeof window === "undefined") return
	installed = true
	window.addEventListener("error", (event) => {
		const where = event.filename ? " (" + event.filename.split("/").pop() + ":" + event.lineno + ")" : ""
		remember(describe(event.error ?? event.message) + where)
	})
	window.addEventListener("unhandledrejection", (event) => remember("unhandled: " + describe(event.reason)))
}

export function recentErrors(): string[] {
	return errorLog.slice()
}

export function collectDiagnostics(language: string): Diagnostics {
	return {
		version: APP_VERSION,
		build: APP_BUILD,
		platform: platformKind(),
		userAgent: navigator.userAgent,
		language,
		screen: `${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}x`,
		viewport: `${window.innerWidth}x${window.innerHeight}`,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
		online: String(navigator.onLine),
		page: location.pathname,
		errors: recentErrors(),
	}
}
