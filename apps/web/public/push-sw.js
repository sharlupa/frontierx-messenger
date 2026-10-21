/* FrontierX web push handler, imported by the generated service worker.
 *
 * The server only knows that something happened in a chat (message bodies are
 * end-to-end encrypted), so a notification names the chat and the account.
 * Tapping it opens the app on that chat, switching accounts when needed.
 */
/* eslint-disable no-restricted-globals */

self.addEventListener("push", (event) => {
	let data = {}
	try {
		data = event.data ? event.data.json() : {}
	} catch (error) {
		data = {}
	}
	const title = typeof data.title === "string" && data.title ? data.title : "FrontierX"
	const body = typeof data.body === "string" ? data.body : ""
	const conversationId = typeof data.conversationId === "string" ? data.conversationId : ""
	const accountId = typeof data.accountId === "string" ? data.accountId : ""
	const accountName = typeof data.accountName === "string" ? data.accountName : ""
	const isCall = data.type === "call"
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			// An open, visible window shows its own in-app notice.
			const visible = windows.some((client) => client.visibilityState === "visible" && client.focused)
			if (visible && !isCall) return undefined
			return self.registration.showNotification(title, {
				body: accountName && body ? body + " · " + accountName : body || accountName,
				tag: (accountId || "fx") + ":" + (conversationId || "general"),
				renotify: true,
				icon: "/icons/icon-192.png",
				badge: "/icons/badge-96.png",
				requireInteraction: isCall,
				vibrate: isCall ? [240, 120, 240, 120, 240] : [120],
				data: { conversationId, accountId },
			})
		}),
	)
})

self.addEventListener("notificationclick", (event) => {
	event.notification.close()
	const data = event.notification.data || {}
	const conversationId = typeof data.conversationId === "string" ? data.conversationId : ""
	const accountId = typeof data.accountId === "string" ? data.accountId : ""
	const target = "/?app=1" + (conversationId ? "&open=" + encodeURIComponent(conversationId) : "") + (accountId ? "&account=" + encodeURIComponent(accountId) : "")
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			for (const client of windows) {
				if ("focus" in client) {
					client.postMessage({ type: "frontierx:open", conversationId, accountId })
					return client.focus()
				}
			}
			return self.clients.openWindow ? self.clients.openWindow(target) : undefined
		}),
	)
})

/* The app's page comes from the network whenever there is one, so each start
 * runs the latest build (no Ctrl+F5 after an update); the precached copy is
 * only for when the server cannot be reached, so chats saved on the device
 * can still be read. Workbox would otherwise answer from its copy first and
 * the new build would show only on the start after next.
 *
 * The Android app opens "/", which the server answers with the app for its
 * WebView; in a browser "/" is the landing page and is left alone, like the
 * other pages of the site (keep in step with navigateFallbackDenylist in
 * vite.config.ts).
 */
const APP_NETWORK_WAIT_MS = 5000
const SITE_PAGES = [/^[/]home/, /^[/]download/, /^[/]features/, /^[/]privacy/, /^[/]delete-account/, /^[/]changes/, /^[/]changelog/, /^[/]site[/]/, /^[/]releases[/]/, /^[/]sdk[/]/]

function isAndroidAppWebView() {
	const ua = (self.navigator && self.navigator.userAgent) || ""
	return ua.indexOf("; wv)") >= 0 || ua.toLowerCase().indexOf("frontierx-app") >= 0
}

function isAppPage(url) {
	if (url.pathname === "/") return isAndroidAppWebView() || url.searchParams.get("app") === "1"
	return !SITE_PAGES.some((pattern) => pattern.test(url.pathname))
}

function keptAppPage() {
	return caches.match("/index.html", { ignoreSearch: true })
}

async function appPageNetworkFirst(request) {
	const network = fetch(request)
	let timer = null
	const slow = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), APP_NETWORK_WAIT_MS)
	})
	try {
		const first = await Promise.race([network, slow])
		// A proxy error page means the server is down: the kept copy is better.
		if (first && first.status < 500) return first
		const kept = await keptAppPage()
		if (kept) {
			network.catch(() => undefined)
			return kept
		}
		return first || (await network)
	} catch (error) {
		const kept = await keptAppPage()
		if (kept) return kept
		throw error
	} finally {
		if (timer) clearTimeout(timer)
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request
	if (request.method !== "GET" || request.mode !== "navigate") return
	const url = new URL(request.url)
	if (url.origin !== self.location.origin || !isAppPage(url)) return
	// Answered here; the precache route registered after this must not try too.
	event.stopImmediatePropagation()
	event.respondWith(appPageNetworkFirst(request))
})
