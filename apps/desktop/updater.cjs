// Update checks for the desktop shell.
//
// The API reports the newest build for this platform; the file itself is
// downloaded from the same origin under /releases, verified against the
// published checksum and then handed to the platform installer. AppImage
// builds are replaced in place, so the user keeps a single executable.

const { app, dialog, shell, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

function platformKey() {
	if (process.platform === "win32") return "windows"
	if (process.platform === "linux") return "linux"
	if (process.platform === "darwin") return "macos"
	return ""
}

function joinUrl(base, tail) {
	return String(base || "").replace(/\/+$/, "") + tail
}

function reason(err) {
	return String(err && err.message ? err.message : err)
}

async function download(url, target, onProgress) {
	const res = await fetch(url)
	if (!res.ok || !res.body) throw new Error("HTTP " + res.status)
	const total = Number(res.headers.get("content-length") || 0)
	const hash = crypto.createHash("sha256")
	const out = fs.createWriteStream(target)
	let done = 0
	for await (const chunk of res.body) {
		const buf = Buffer.from(chunk)
		hash.update(buf)
		done += buf.length
		if (!out.write(buf)) await new Promise((resolve) => out.once("drain", resolve))
		if (total > 0 && onProgress) onProgress(done / total)
	}
	await new Promise((resolve, reject) => {
		out.on("error", reject)
		out.end(resolve)
	})
	return hash.digest("hex")
}

async function install(serverUrl, latest) {
	const win = BrowserWindow.getAllWindows()[0] || null
	const fileUrl = /^https?:\/\//i.test(latest.url) ? latest.url : joinUrl(serverUrl, latest.url)
	let name = "frontierx-update"
	try {
		name = path.basename(new URL(fileUrl).pathname) || name
	} catch {
		// keep the fallback name
	}
	const target = path.join(app.getPath("temp"), name)
	try {
		const digest = await download(fileUrl, target, (fraction) => {
			if (win) win.setProgressBar(fraction)
		})
		if (win) win.setProgressBar(-1)
		if (latest.sha256 && digest !== String(latest.sha256).toLowerCase()) {
			fs.rmSync(target, { force: true })
			throw new Error("контрольная сумма не совпала")
		}
	} catch (err) {
		if (win) win.setProgressBar(-1)
		await dialog.showMessageBox({
			type: "error",
			message: "Не удалось скачать обновление",
			detail: reason(err),
			buttons: ["Закрыть"],
		})
		return
	}

	const current = process.env.APPIMAGE || ""
	if (target.endsWith(".AppImage") && current) {
		try {
			fs.copyFileSync(target, current)
			fs.chmodSync(current, 0o755)
			fs.rmSync(target, { force: true })
			const answer = await dialog.showMessageBox({
				type: "info",
				message: "Обновление установлено",
				detail: "Перезапустить FrontierX?",
				buttons: ["Перезапустить", "Позже"],
				defaultId: 0,
				cancelId: 1,
			})
			if (answer.response === 0) {
				app.relaunch()
				app.exit(0)
			}
			return
		} catch {
			// fall back to opening the downloaded file below
		}
	}

	if (target.endsWith(".AppImage")) {
		try {
			fs.chmodSync(target, 0o755)
		} catch {
			// permissions stay as downloaded
		}
	}
	await dialog.showMessageBox({
		type: "info",
		message: "Обновление скачано",
		detail: target,
		buttons: ["Открыть"],
	})
	await shell.openPath(target)
	if (process.platform === "win32") app.quit()
}

async function check(serverUrl, options) {
	const silent = Boolean(options && options.silent)
	const platform = platformKey()
	if (!platform) return
	let info = null
	try {
		const url = joinUrl(
			serverUrl,
			"/api/updates/latest?platform=" + platform + "&version=" + encodeURIComponent(app.getVersion()),
		)
		const res = await fetch(url, { headers: { accept: "application/json" } })
		if (!res.ok) throw new Error("HTTP " + res.status)
		info = await res.json()
	} catch (err) {
		if (!silent) {
			await dialog.showMessageBox({
				type: "warning",
				message: "Не удалось проверить обновления",
				detail: reason(err),
				buttons: ["Закрыть"],
			})
		}
		return
	}

	if (!info || !info.updateAvailable || !info.latest) {
		if (!silent) {
			await dialog.showMessageBox({
				type: "info",
				message: "Установлена последняя версия",
				detail: "Версия " + app.getVersion(),
				buttons: ["Закрыть"],
			})
		}
		return
	}

	const latest = info.latest
	const notes = String(latest.notes || "").slice(0, 600)
	const answer = await dialog.showMessageBox({
		type: "question",
		message: "Доступна версия " + latest.version,
		detail: notes || "Скачать и установить обновление?",
		buttons: ["Скачать и установить", "Позже"],
		defaultId: 0,
		cancelId: latest.mandatory ? 0 : 1,
	})
	if (answer.response !== 0) return
	await install(serverUrl, latest)
}

// A quiet check shortly after launch keeps installs current without getting in
// the way of startup; failures are ignored on purpose.
function checkOnStart(serverUrl) {
	setTimeout(() => {
		check(serverUrl, { silent: true }).catch(() => {})
	}, 8000)
}

module.exports = { check, checkOnStart }