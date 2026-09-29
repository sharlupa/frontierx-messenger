// Small, safe bridge for the setup page and for native desktop notifications.
// Harmless on the loaded web app, which feature-detects both bridges.
const { contextBridge, ipcRenderer } = require("electron")

let windowFocused = true

contextBridge.exposeInMainWorld("frontierxDesktop", {
	getConfig: () => ipcRenderer.invoke("frontierx:get-config"),
	saveServerUrl: (url) => ipcRenderer.invoke("frontierx:save-server", url),
})

// The web client prefers window.FrontierXNative.notify() over the Web
// Notification API. Inside an Electron shell the Chromium path is unreliable on
// Linux (permission state and focus are not what the window manager reports),
// so notifications are handed to the main process instead.
contextBridge.exposeInMainWorld("FrontierXNative", {
	platform: "desktop",
	isFocused: () => windowFocused,
	checkUpdates: () => {
		ipcRenderer.invoke("frontierx:check-updates").catch(() => {})
	},
	notify: (title, body, tag) => {
		ipcRenderer.send("frontierx:notify", {
			title: String(title == null ? "" : title),
			body: String(body == null ? "" : body),
			tag: String(tag == null ? "" : tag),
		})
	},
})

ipcRenderer.on("frontierx:focus-state", (_event, focused) => {
	windowFocused = Boolean(focused)
})

// Notification clicks are relayed to the page; the web client listens for this
// message and opens the matching conversation.
ipcRenderer.on("frontierx:notification-click", (_event, tag) => {
	try {
		window.postMessage(
			{ type: "frontierx:notification-click", tag: String(tag == null ? "" : tag) },
			"*",
		)
	} catch {
		// the page is not ready yet
	}
})