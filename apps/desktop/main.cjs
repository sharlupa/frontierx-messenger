// FrontierX desktop shell (Electron) for Linux, Windows and macOS.
//
// Wraps the existing FrontierX web client in a native window. It loads a
// configurable server URL (local, LAN, or a public server) and grants
// microphone access so voice/video calls work without extra browser setup.
//
// Like other messengers it keeps running in the system tray when the window is
// closed and starts with the system (hidden), so messages and calls arrive as
// desktop notifications without the window being open.

const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell, ipcMain, systemPreferences } = require("electron")
const os = require("node:os")
const path = require("node:path")
const fs = require("node:fs")
const updater = require("./updater.cjs")

const DEFAULT_SERVER_URL = "https://frontierx.zkito.fun"
const CONFIG_VERSION = 2
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json")
const SETUP_PAGE = path.join(__dirname, "renderer", "setup.html")

function readConfig() {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
		const usable =
			parsed &&
			typeof parsed.serverUrl === "string" &&
			parsed.serverUrl.trim() &&
			parsed.configVersion >= CONFIG_VERSION
		if (usable) return parsed
	} catch {
		// no config yet or unreadable
	}
	return { serverUrl: DEFAULT_SERVER_URL, configVersion: CONFIG_VERSION }
}

// Settings that are not about the server live next to it in the same file.
function readPrefs() {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

function writePrefs(patch) {
	const merged = { ...readPrefs(), ...patch }
	try {
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8")
	} catch (err) {
		console.error("[frontierx] failed to save settings:", err)
	}
}

function writeConfig(config) {
	try {
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8")
	} catch (err) {
		console.error("[frontierx] failed to save config:", err)
	}
}

function normalizeUrl(input) {
	const value = String(input || "").trim()
	if (!value) return ""
	const withProto = /^https?:\/\//i.test(value) ? value : "http://" + value
	return withProto.replace(/\/+$/, "")
}

function originOf(url) {
	try {
		return new URL(url).origin
	} catch {
		return ""
	}
}

// Voice calls need a secure context for getUserMedia. https and
// localhost/127.0.0.1 already qualify; a plain-http LAN address (e.g.
// http://192.168.x.x:8080) does not, so we opt that specific origin in.
const startupOrigin = originOf(readConfig().serverUrl)
if (
	startupOrigin &&
	/^http:\/\//i.test(startupOrigin) &&
	!/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(startupOrigin)
) {
	app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", startupOrigin)
	app.commandLine.appendSwitch("disable-features", "BlockInsecurePrivateNetworkRequests")
}

let mainWindow = null
let tray = null
// Set when the user really quits (tray menu, updater, system shutdown); until
// then closing the window only hides it.
let quitting = false
const isMac = process.platform === "darwin"
// Started by the system at login: stay in the tray until the user opens it.
// macOS login items take no arguments and report it themselves (checked once
// the app is ready).
let startedHidden = process.argv.includes("--hidden")

const ru = () => String(app.getLocale() || "").toLowerCase().startsWith("ru")
const T = {
	open: () => (ru() ? "Открыть FrontierX" : "Open FrontierX"),
	autostart: () => (ru() ? "Запускать при входе в систему" : "Start with the system"),
	quit: () => (ru() ? "Выйти" : "Quit"),
	trayTitle: () => (ru() ? "FrontierX работает в трее" : "FrontierX keeps running in the tray"),
	trayBody: () => (ru()
		? "Сообщения и звонки будут приходить уведомлениями. Чтобы закрыть полностью — «Выйти» в меню значка."
		: "Messages and calls will arrive as notifications. To quit completely, use “Quit” in the tray menu."),
}

// Notifications.
//
// The renderer's Web Notification API path does not reach the Linux
// notification daemon reliably from an Electron shell, so the web client calls
// window.FrontierXNative.notify() (exposed in preload.cjs) and the main process
// emits a real desktop notification here.
const notificationsByTag = new Map()

function findNotificationIcon() {
	const candidates = [
		path.join(__dirname, "renderer", "icon.png"),
		path.join(__dirname, "build", "icon.png"),
		path.join(process.resourcesPath || __dirname, "icon.png"),
	]
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate
		} catch {
			// ignore unreadable candidates
		}
	}
	return undefined
}

const NOTIFICATION_ICON = findNotificationIcon()

function windowIsActive() {
	if (!mainWindow || mainWindow.isDestroyed()) return false
	if (mainWindow.isMinimized() || !mainWindow.isVisible()) return false
	return mainWindow.isFocused()
}

function sendFocusState() {
	if (!mainWindow || mainWindow.isDestroyed()) return
	try {
		mainWindow.webContents.send("frontierx:focus-state", windowIsActive())
	} catch {
		// the window is going away
	}
}

function showNotification(payload) {
	if (!Notification.isSupported()) return
	const title = String((payload && payload.title) || "FrontierX").slice(0, 200)
	const body = String((payload && payload.body) || "").slice(0, 600)
	const tag = String((payload && payload.tag) || "frontierx")

	// Mirror the Web Notification "tag" behaviour: one live notification per
	// conversation, newest wins.
	const previous = notificationsByTag.get(tag)
	if (previous) {
		try {
			previous.close()
		} catch {
			// already dismissed
		}
	}

	const note = new Notification({ title, body, icon: NOTIFICATION_ICON, urgency: "normal" })
	notificationsByTag.set(tag, note)
	note.on("click", () => {
		if (!mainWindow || mainWindow.isDestroyed()) return
		if (mainWindow.isMinimized()) mainWindow.restore()
		if (!mainWindow.isVisible()) mainWindow.show()
		mainWindow.focus()
		try {
			mainWindow.webContents.send("frontierx:notification-click", tag)
		} catch {
			// the renderer is not ready
		}
	})
	note.on("close", () => {
		if (notificationsByTag.get(tag) === note) notificationsByTag.delete(tag)
	})
	note.show()
}

// --- Tray, background running and autostart ---------------------------------

function showWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) {
		createWindow(true)
		return
	}
	if (mainWindow.isMinimized()) mainWindow.restore()
	mainWindow.show()
	mainWindow.focus()
}

// Where the system should start us from. A portable Windows build runs from a
// temporary copy, and an AppImage from a mount point, so both report the real
// file through environment variables.
function launchTarget() {
	return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath
}

const AUTOSTART_FILE = path.join(os.homedir(), ".config", "autostart", "frontierx.desktop")

function autostartEnabled() {
	if (process.platform === "linux") return fs.existsSync(AUTOSTART_FILE)
	if (isMac) return app.getLoginItemSettings().openAtLogin
	return app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin
}

function setAutostart(enabled) {
	try {
		if (process.platform === "linux") {
			// Electron has no login-item API on Linux; the freedesktop autostart
			// entry is what every desktop environment reads.
			if (enabled) {
				fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true })
				const exec = '"' + launchTarget().replace(/"/g, '\\"') + '" --hidden'
				fs.writeFileSync(AUTOSTART_FILE, [
					"[Desktop Entry]",
					"Type=Application",
					"Name=FrontierX",
					"Comment=Messenger",
					"Exec=" + exec,
					"Icon=frontierx",
					"Terminal=false",
					"X-GNOME-Autostart-enabled=true",
					"",
				].join("\n"))
			} else if (fs.existsSync(AUTOSTART_FILE)) {
				fs.rmSync(AUTOSTART_FILE)
			}
		} else if (isMac) {
			app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
		} else {
			app.setLoginItemSettings({ openAtLogin: enabled, path: launchTarget(), args: ["--hidden"] })
		}
	} catch (err) {
		console.error("[frontierx] autostart change failed:", err)
	}
	writePrefs({ autostart: enabled })
	buildTrayMenu()
}

function buildTrayMenu() {
	if (!tray) return
	tray.setContextMenu(Menu.buildFromTemplate([
		{ label: T.open(), click: showWindow },
		{ type: "separator" },
		{ label: T.autostart(), type: "checkbox", checked: autostartEnabled(), click: (item) => setAutostart(item.checked) },
		{ type: "separator" },
		{ label: T.quit(), click: () => { quitting = true; app.quit() } },
	]))
}

function createTray() {
	// The macOS menu bar wants a black "template" image that the system tints
	// for light and dark bars (trayTemplate@2x.png is picked up for Retina).
	const file = path.join(__dirname, "renderer", isMac ? "trayTemplate.png" : "tray.png")
	let image = nativeImage.createFromPath(file)
	if (image.isEmpty()) return
	if (isMac) image.setTemplateImage(true)
	else image = image.resize({ width: process.platform === "win32" ? 16 : 22, height: process.platform === "win32" ? 16 : 22, quality: "best" })
	tray = new Tray(image)
	tray.setToolTip("FrontierX")
	tray.on("click", () => {
		if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide()
		else showWindow()
	})
	buildTrayMenu()
}

function openSetup(error) {
	if (!mainWindow) return
	mainWindow.loadFile(SETUP_PAGE, error ? { query: { error: "1" } } : undefined)
}

function loadServer(url) {
	if (!mainWindow) return
	const target = normalizeUrl(url)
	if (!target) {
		openSetup(false)
		return
	}
	mainWindow.loadURL(target).catch(() => undefined)
}

function createWindow(visible = true) {
	mainWindow = new BrowserWindow({
		show: visible,
		width: 1180,
		height: 800,
		minWidth: 480,
		minHeight: 560,
		backgroundColor: "#0e1621",
		title: "FrontierX",
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: true,
			// The hidden window keeps its realtime socket and timers running, which
			// is what delivers notifications while FrontierX sits in the tray.
			backgroundThrottling: false,
		},
	})

	// Menu bar removed; the server address is built into the app.
	mainWindow.setMenuBarVisibility(false)

	// Grant microphone (and a few related) permissions so calls work, and
	// location for "share my location" in a chat. Only the FrontierX server's
	// own pages get them.
	const allowed = new Set([
		"media",
		"clipboard-read",
		"clipboard-sanitized-write",
		"notifications",
		"geolocation",
		"fullscreen",
	])
	const fromServer = (url) => {
		const origin = originOf(url)
		return origin !== "" && origin === originOf(readConfig().serverUrl)
	}
	const ses = mainWindow.webContents.session
	ses.setPermissionRequestHandler((wc, permission, callback, details) => {
		if (!allowed.has(permission) || !fromServer((details && details.requestingUrl) || wc.getURL())) {
			callback(false)
			return
		}
		// macOS asks the person once per device (camera, microphone) before the
		// page can use it; the answer is remembered by the system.
		if (isMac && permission === "media" && systemPreferences.askForMediaAccess) {
			const types = (details && details.mediaTypes) || ["audio"]
			Promise.all(types.map((type) => (type === "video" ? systemPreferences.askForMediaAccess("camera") : systemPreferences.askForMediaAccess("microphone"))))
				.then((answers) => callback(answers.every(Boolean)))
				.catch(() => callback(false))
			return
		}
		callback(true)
	})
	ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && (!requestingOrigin || fromServer(requestingOrigin)))

	// Open external links in the user's default browser.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//i.test(url)) shell.openExternal(url)
		return { action: "deny" }
	})

	// If the server can't be reached, show the setup page with an error.
	mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL, isMainFrame) => {
		if (!isMainFrame) return
		if (errorCode === -3) return // ERR_ABORTED (normal during redirects)
		if (validatedURL && validatedURL.startsWith("file://")) return // the setup page itself
		openSetup(true)
	})

	// Keep the renderer in sync with real window state, so it can choose between
	// an in-app card and a system notification.
	for (const windowEvent of ["focus", "blur", "show", "hide", "minimize", "restore"]) {
		mainWindow.on(windowEvent, sendFocusState)
	}
	mainWindow.webContents.on("did-finish-load", sendFocusState)

	loadServer(readConfig().serverUrl)

	// Closing the window keeps the app in the tray; only "Quit" ends it.
	mainWindow.on("close", (event) => {
		if (quitting || !tray) return
		event.preventDefault()
		mainWindow.hide()
		if (!readPrefs().trayHintShown && Notification.isSupported()) {
			writePrefs({ trayHintShown: true })
			new Notification({ title: T.trayTitle(), body: T.trayBody(), icon: NOTIFICATION_ICON }).show()
		}
	})

	mainWindow.on("closed", () => {
		mainWindow = null
	})
}

ipcMain.handle("frontierx:get-config", () => readConfig())

ipcMain.handle("frontierx:save-server", (_event, url) => {
	const normalized = normalizeUrl(url)
	writeConfig({ ...readPrefs(), serverUrl: normalized, configVersion: CONFIG_VERSION })
	if (normalized) loadServer(normalized)
	return { ok: true, serverUrl: normalized }
})

ipcMain.on("frontierx:notify", (_event, payload) => {
	showNotification(payload)
})

ipcMain.handle("frontierx:is-focused", () => windowIsActive())

// Settings in the web client offer a manual update check; the request is
// answered by the API and the download is handled by the main process.
ipcMain.handle("frontierx:check-updates", async () => {
	await updater.check(readConfig().serverUrl, { silent: false })
	return { ok: true }
})

app.setName("FrontierX")
if (process.platform === "win32") app.setAppUserModelId("com.frontierx.desktop")
if (process.platform === "linux" && typeof app.setDesktopName === "function") {
	app.setDesktopName("frontierx.desktop")
}
// One running copy: starting FrontierX again just brings the window back.
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on("second-instance", () => showWindow())

	app.whenReady().then(() => {
		// macOS keeps copy, paste, undo and quit in the app menu: without it the
		// usual keyboard shortcuts do nothing. Elsewhere there is no menu bar.
		Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([
			{ role: "appMenu" },
			{ role: "editMenu" },
			{ label: ru() ? "Вид" : "View", submenu: [{ role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
			{ role: "windowMenu" },
		]) : null)
		if (isMac && app.getLoginItemSettings().wasOpenedAsHidden) startedHidden = true
		createTray()
		createWindow(!(startedHidden && tray))
		// Start with the system by default, once; the tray menu turns it off.
		if (readPrefs().autostart === undefined) setAutostart(true)
		updater.checkOnStart(readConfig().serverUrl)
		app.on("activate", () => showWindow())
	})
}

app.on("before-quit", () => {
	quitting = true
})

app.on("window-all-closed", () => {
	// With a tray icon the window is only hidden; without one (no tray support
	// on this desktop) closing it still quits as before.
	if (!tray && process.platform !== "darwin") app.quit()
})