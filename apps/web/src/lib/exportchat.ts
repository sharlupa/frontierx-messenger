// Export of a conversation into a single readable HTML file. Everything is
// decrypted on the device first - the file that lands in Downloads is plain,
// so treat it like any other copy of the correspondence.

import { formatDateTime, plural, translate, type Lang } from "./i18n"

export interface ExportMessage {
	author: string
	createdAt: string
	text: string
	kind: "text" | "media" | "poll" | "locked" | "deleted"
	detail?: string
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

export function buildExportHtml(title: string, messages: ExportMessage[], lang: Lang): string {
	const heading = escapeHtml(title)
	const stamp = formatDateTime(lang, new Date().toISOString())
	const rows = messages
		.map((message) => {
			const time = formatDateTime(lang, message.createdAt)
			const body = message.kind === "text"
				? escapeHtml(message.text)
				: '<em class="note">' + escapeHtml(message.detail ?? message.text) + "</em>"
			return (
				'<div class="m"><div class="h"><b>' + escapeHtml(message.author) + '</b><span>' + escapeHtml(time) + "</span></div><div class=\"b\">" + body + "</div></div>"
			)
		})
		.join("\n")
	return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading}</title>
<style>
body { margin: 0; background: #0e1621; color: #e9eef3; font: 15px/1.6 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.wrap { max-width: 760px; margin: 0 auto; padding: 28px 18px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta { color: #8b98a5; font-size: 13px; margin-bottom: 22px; }
.m { padding: 10px 0; border-bottom: 1px solid #23303d; }
.h { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: #8b98a5; }
.h b { color: #3390ec; font-weight: 600; }
.b { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 3px; }
.note { color: #8b98a5; }
</style>
</head>
<body>
<div class="wrap">
<h1>${heading}</h1>
<div class="meta">${escapeHtml(translate(lang, "exportedAt"))}: ${escapeHtml(stamp)} · ${escapeHtml(plural(lang, "messages", messages.length))}</div>
${rows}
</div>
</body>
</html>`
}

export function downloadTextFile(name: string, content: string, mime = "text/html;charset=utf-8"): void {
	const blob = new Blob([content], { type: mime })
	const url = URL.createObjectURL(blob)
	const link = document.createElement("a")
	link.href = url
	link.download = name
	document.body.appendChild(link)
	link.click()
	link.remove()
	window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function safeFileName(title: string): string {
	const cleaned = title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim()
	const base = cleaned ? cleaned.slice(0, 60) : "chat"
	const date = new Date().toISOString().slice(0, 10)
	return base + " " + date + ".html"
}
