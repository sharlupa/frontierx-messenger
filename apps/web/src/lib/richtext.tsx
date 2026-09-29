import { createElement, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"

// Lightweight message formatting. The message body stays plain text on the
// wire - the markers below are parsed only when a bubble is drawn, so nothing
// changes about encryption, search or older clients.
//
//   *bold*   _italic_   ~strike~   `code`   ```block```   > quote   @mention
//   ||spoiler|| (hidden until tapped)
//
// The parser builds React nodes directly; no HTML is ever produced from user
// input, so there is nothing to inject.

const INLINE_SOURCE = "(\\|\\|[^|\\n]+\\|\\|)|(`[^`\\n]+`)|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)|(~[^~\\n]+~)|(@[A-Za-z0-9_.-]{2,32})|(https?:\\/\\/[^\\s<]+)"

// Hidden text: shimmering noise until tapped, then the words. Revealing is
// local to this bubble and this screen.
function Spoiler(props: { children: ReactNode }) {
	const [open, setOpen] = useState(false)
	const reveal = () => setOpen(true)
	return createElement(
		"span",
		{
			className: "md-spoiler" + (open ? " revealed" : ""),
			role: open ? undefined : "button",
			tabIndex: open ? undefined : 0,
			"aria-label": open ? undefined : "spoiler",
			onClick: (event: ReactMouseEvent) => {
				if (open) return
				event.stopPropagation()
				reveal()
			},
			onKeyDown: (event: KeyboardEvent) => {
				if (!open && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault()
					reveal()
				}
			},
		},
		createElement("span", { className: "md-spoiler-text", "aria-hidden": open ? undefined : true }, props.children),
	)
}

export type MentionTest = (name: string) => boolean

function inlineNodes(text: string, keyPrefix: string, isMention?: MentionTest, onMention?: (name: string) => void): ReactNode[] {
	const out: ReactNode[] = []
	let last = 0
	let match: RegExpExecArray | null
	// A fresh matcher per call: this function recurses into nested markers, and
	// a shared /g/ regex would have its lastIndex clobbered by the inner pass.
	const scanner = new RegExp(INLINE_SOURCE, "g")
	let index = 0
	while ((match = scanner.exec(text)) !== null) {
		if (match.index > last) out.push(text.slice(last, match.index))
		const token = match[0]
		const key = keyPrefix + "-" + String(index++)
		if (token.startsWith("||")) {
			out.push(createElement(Spoiler, { key, children: inlineNodes(token.slice(2, -2), key, isMention, onMention) }))
		} else if (token.startsWith("`")) {
			out.push(createElement("code", { key, className: "md-code" }, token.slice(1, -1)))
		} else if (token.startsWith("*")) {
			out.push(createElement("strong", { key }, inlineNodes(token.slice(1, -1), key, isMention, onMention)))
		} else if (token.startsWith("_")) {
			out.push(createElement("em", { key }, inlineNodes(token.slice(1, -1), key, isMention, onMention)))
		} else if (token.startsWith("~")) {
			out.push(createElement("s", { key }, inlineNodes(token.slice(1, -1), key, isMention, onMention)))
		} else if (token.startsWith("@")) {
			const name = token.slice(1)
			const known = isMention ? isMention(name) : false
			out.push(createElement(
				"span",
				{
					key,
					className: "md-mention" + (known ? " known" : ""),
					onClick: known && onMention ? () => onMention(name) : undefined,
				},
				token,
			))
		} else {
			out.push(createElement("a", { key, className: "md-link", href: token, target: "_blank", rel: "noreferrer noopener" }, token))
		}
		last = match.index + token.length
		if (token.length === 0) scanner.lastIndex += 1
	}
	if (last < text.length) out.push(text.slice(last))
	return out
}

export function renderRichText(text: string, isMention?: MentionTest, onMention?: (name: string) => void): ReactNode {
	if (!text) return text
	const blocks: ReactNode[] = []
	// Fenced code first: everything inside is verbatim.
	const parts = text.split(/```/)
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]
		if (i % 2 === 1) {
			blocks.push(createElement("pre", { key: "pre-" + String(i), className: "md-pre" }, createElement("code", null, part.replace(/^\n/, ""))))
			continue
		}
		if (!part) continue
		const lines = part.split("\n")
		let quote: string[] = []
		const flushQuote = (at: number) => {
			if (quote.length === 0) return
			blocks.push(createElement("blockquote", { key: "q-" + String(i) + "-" + String(at), className: "md-quote" }, inlineNodes(quote.join("\n"), "q" + String(i) + String(at), isMention, onMention)))
			quote = []
		}
		let buffer: ReactNode[] = []
		const flushText = (at: number) => {
			if (buffer.length === 0) return
			blocks.push(createElement("span", { key: "t-" + String(i) + "-" + String(at) }, buffer))
			buffer = []
		}
		for (let line = 0; line < lines.length; line++) {
			const value = lines[line]
			if (value.startsWith("> ")) {
				flushText(line)
				quote.push(value.slice(2))
				continue
			}
			flushQuote(line)
			buffer.push(...inlineNodes(value, "i" + String(i) + "-" + String(line), isMention, onMention))
			if (line < lines.length - 1) buffer.push(createElement("br", { key: "br-" + String(i) + "-" + String(line) }))
		}
		flushQuote(lines.length)
		flushText(lines.length)
	}
	return blocks.length === 1 ? blocks[0] : blocks
}

// Plain-text version used for previews, replies and notifications: markers
// go, and hidden (spoiler) text is replaced so it never leaks into a preview.
export function stripFormatting(text: string): string {
	return text
		.replace(/\|\|([^|\n]+)\|\|/g, (_match, inner: string) => "•".repeat(Math.min(10, Math.max(3, inner.length))))
		.replace(/```([\s\S]*?)```/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1")
		.replace(/_([^_\n]+)_/g, "$1")
		.replace(/~([^~\n]+)~/g, "$1")
		.replace(/^> /gm, "")
}

export function mentionsUser(text: string, username: string): boolean {
	if (!text || !username) return false
	const pattern = new RegExp("(^|[^A-Za-z0-9_.-])@" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^A-Za-z0-9_.-])", "i")
	return pattern.test(text)
}
