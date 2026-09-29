import { getActiveLang, translateServerError } from "./i18n"

// One place that turns a thrown value into text for the user: messages from
// the server or from our own validation are translated when known, anything
// without a message falls back to the caller's (already translated) text.
export function errorText(err: unknown, fallback: string): string {
	if (err instanceof Error && err.message) return translateServerError(getActiveLang(), err.message)
	return fallback
}
