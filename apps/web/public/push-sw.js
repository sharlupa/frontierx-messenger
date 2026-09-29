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
