import { createElement, useEffect, useRef, useState } from "react"
import type { ChangeEvent, ClipboardEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { useSettings } from "../state/settings"
import { EmojiPanel } from "./EmojiPanel"
import type { BotCommand, SendOptions, Sticker } from "../lib/types"
import { IconClose } from "./Icons"
import { VoiceRecorder, formatDuration, voiceRecordingSupported, type VoiceRecording } from "../lib/voice"
import type { ContactPayload, LocationPayload } from "../lib/richmsg"
import { Menu, type MenuItemSpec } from "./m3"
import { IContact, IEyeOff, IFile, IImage, ILocation, IPoll, ISchedule, ISilent, ISpoiler } from "./m3icons"
import { LocationSheet } from "./LocationSheet"
import { ContactSheet } from "./ContactSheet"
import { ScheduleSheet } from "./ScheduleSheet"

// Recordings shorter than this are almost always a mis-tap on the mic button.
const MIN_VOICE_SECONDS = 0.6
const METER_BARS = 28

export const MAX_ATTACHMENT_MB = 1024

export type ComposerDraft = {
	replyToId: string | null
	replyToText: string | null
	editingId: string | null
	editingText: string | null
}

function IconPaperclip() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L9.4 17.05a2 2 0 0 1-2.83-2.83l8.49-8.48" />
		</svg>
	)
}

function IconMic() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="9" y="2.5" width="6" height="11" rx="3" />
			<path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
			<line x1="12" y1="17.5" x2="12" y2="21" />
			<line x1="8.5" y1="21" x2="15.5" y2="21" />
		</svg>
	)
}

function IconTrash() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M4 7h16" />
			<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
			<path d="M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
			<line x1="10" y1="11" x2="10" y2="17" />
			<line x1="14" y1="11" x2="14" y2="17" />
		</svg>
	)
}

function IconSend() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
			<path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4.92V9.5c0 .5.37.93.87.99L14 12 2.87 13.5a1 1 0 0 0-.87 1v4.98a1 1 0 0 0 1.4.92z" />
		</svg>
	)
}

function IconEmoji() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			<path d="M8 14s1.5 2 4 2 4-2 4-2" />
			<line x1="9" y1="9.5" x2="9.01" y2="9.5" />
			<line x1="15" y1="9.5" x2="15.01" y2="9.5" />
		</svg>
	)
}

export type AttachOptions = SendOptions & { spoiler?: boolean }

export function Composer({
	disabled,
	draft,
	value,
	onValueChange,
	onSend,
	onSubmitEdit,
	onTyping,
	onCancelDraft,
	onAttach,
	onCreatePoll,
	onSendSticker,
	onSendGif,
	onSendVoice,
	onSendLocation,
	onSendContact,
	dropped = null,
	onDroppedHandled,
	mentions = [],
	commands = [],
}: {
	disabled: boolean
	draft: ComposerDraft
	value: string
	onValueChange: (value: string) => void
	onSend: (body: string, replyToId: string | null, options?: SendOptions) => void | Promise<void>
	onSubmitEdit: (messageId: string, body: string) => void | Promise<void>
	onTyping: () => void
	onCancelDraft: () => void
	onAttach: (file: File, caption: string, options?: AttachOptions) => void | Promise<void>
	onCreatePoll: (opener: HTMLButtonElement) => void
	onSendSticker?: (sticker: Sticker) => void | Promise<void>
	onSendGif?: (url: string) => void | Promise<void>
	onSendVoice?: (recording: VoiceRecording, options?: SendOptions) => void | Promise<void>
	onSendLocation?: (location: LocationPayload, options?: SendOptions) => void | Promise<void>
	onSendContact?: (contact: ContactPayload, options?: SendOptions) => void | Promise<void>
	dropped?: File[] | null
	onDroppedHandled?: () => void
	mentions?: Array<{ username: string; displayName: string }>
	// A bot's commands, offered when the message starts with "/".
	commands?: BotCommand[]
}) {
	const { t } = useSettings()
	const inputRef = useRef<HTMLTextAreaElement | null>(null)
	const fileRef = useRef<HTMLInputElement | null>(null)
	const mediaRef = useRef<HTMLInputElement | null>(null)
	const attachRef = useRef<HTMLButtonElement | null>(null)
	const sendRef = useRef<HTMLButtonElement | null>(null)
	const [showEmoji, setShowEmoji] = useState(false)
	const [attachMenu, setAttachMenu] = useState(false)
	// Long press or right click on send: send silently, or schedule.
	const [sendMenu, setSendMenu] = useState<"text" | "staged" | null>(null)
	const [scheduleFor, setScheduleFor] = useState<"text" | "staged" | null>(null)
	const [sheet, setSheet] = useState<"location" | "contact" | null>(null)
	const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
	const pressTimer = useRef<number | null>(null)
	const pressFired = useRef(false)
	type Staged = { id: string; file: File; preview: string | null; spoiler: boolean }
	const [staged, setStaged] = useState<Staged[]>([])
	const [caption, setCaption] = useState("")
	const [mentionQuery, setMentionQuery] = useState<string | null>(null)
	const [mentionPick, setMentionPick] = useState(0)
	const recorderRef = useRef<VoiceRecorder | null>(null)
	const tickRef = useRef<number | null>(null)
	const [recording, setRecording] = useState(false)
	const [elapsed, setElapsed] = useState(0)
	const [levels, setLevels] = useState<number[]>([])
	const [voiceError, setVoiceError] = useState<string | null>(null)
	const canRecord = Boolean(onSendVoice) && voiceRecordingSupported()

	function stopTick() {
		if (tickRef.current !== null) {
			window.clearInterval(tickRef.current)
			tickRef.current = null
		}
	}

	function resetRecording() {
		stopTick()
		recorderRef.current = null
		setRecording(false)
		setElapsed(0)
		setLevels([])
	}

	async function startRecording() {
		if (disabled || recording || !canRecord) return
		setVoiceError(null)
		const recorder = new VoiceRecorder()
		recorder.onLevel = (level) => setLevels((prev) => prev.concat([level]).slice(-METER_BARS))
		try {
			await recorder.start()
		} catch (err) {
			const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : ""
			setVoiceError(name === "NotAllowedError" || name === "SecurityError" ? t("micDenied") : name === "NotFoundError" ? t("micUnsupported") : t("micFailed"))
			return
		}
		recorderRef.current = recorder
		setRecording(true)
		setElapsed(0)
		setLevels([])
		tickRef.current = window.setInterval(() => setElapsed(recorder.elapsed), 200)
	}

	function cancelRecording() {
		const recorder = recorderRef.current
		resetRecording()
		if (recorder) recorder.cancel()
	}

	async function finishRecording() {
		const recorder = recorderRef.current
		if (!recorder) return
		setVoiceError(null)
		resetRecording()
		let result: VoiceRecording | null = null
		try {
			result = await recorder.stop()
		} catch {
			setVoiceError(t("micFailed"))
			return
		}
		if (!result) {
			setVoiceError(t("micFailed"))
			return
		}
		if (result.duration < MIN_VOICE_SECONDS) {
			setVoiceError(t("voiceTooShort"))
			return
		}
		if (onSendVoice) await onSendVoice(result)
	}

	// A chat switched away from, or a closing window, must not leave the
	// microphone running.
	useEffect(() => {
		return () => {
			stopTick()
			if (recorderRef.current) recorderRef.current.cancel()
			recorderRef.current = null
		}
	}, [])

	useEffect(() => {
		if (disabled && recorderRef.current) cancelRecording()
	}, [disabled])

	useEffect(() => {
		inputRef.current?.focus()
	}, [draft.editingId, draft.replyToId])

	// Previews are revoked when an item is removed and when the composer goes
	// away - never on every change of the list, which used to kill the preview
	// of the items still staged.
	const stagedRef = useRef<Staged[]>([])
	stagedRef.current = staged
	useEffect(() => {
		return () => {
			for (const item of stagedRef.current) if (item.preview) URL.revokeObjectURL(item.preview)
		}
	}, [])

	function stageFiles(files: File[]) {
		if (files.length === 0) return
		const next = files.map((file) => ({
			id: "staged-" + String(Date.now()) + "-" + String(Math.round(Math.random() * 1e6)),
			file,
			preview: file.type.indexOf("image/") === 0 ? URL.createObjectURL(file) : null,
			spoiler: false,
		}))
		setStaged((prev) => prev.concat(next))
	}

	// Files dropped on the conversation arrive from the parent.
	useEffect(() => {
		if (!dropped || dropped.length === 0) return
		stageFiles(dropped)
		if (onDroppedHandled) onDroppedHandled()
	}, [dropped, onDroppedHandled])

	function onPickFile(e: ChangeEvent<HTMLInputElement>) {
		const picked = e.target.files ? Array.from(e.target.files) : []
		e.target.value = ""
		stageFiles(picked)
	}

	// A pasted image arrives either through the file list or as a clipboard
	// item, and in both cases the blob usually carries no name, which the
	// upload cannot describe. A stable name is attached before staging.
	function namedClipboardFile(file: File): File {
		if (file.name && file.name.trim()) return file
		const mime = file.type || "image/png"
		const ext = mime.indexOf("image/") === 0 ? mime.slice(6).split("+")[0] : "bin"
		return new File([file], "clipboard-" + String(Date.now()) + "." + ext, { type: mime, lastModified: Date.now() })
	}

	function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
		if (disabled) return
		const dt = e.clipboardData
		if (!dt) return
		let f: File | null = dt.files && dt.files.length > 0 ? dt.files[0] : null
		if (!f && dt.items) {
			for (let i = 0; i < dt.items.length; i += 1) {
				const item = dt.items[i]
				if (!item || item.kind !== "file") continue
				const picked = item.getAsFile()
				if (picked) {
					f = picked
					break
				}
			}
		}
		if (!f) return
		e.preventDefault()
		stageFiles([namedClipboardFile(f)])
	}
	function clearStaged() {
		for (const item of staged) if (item.preview) URL.revokeObjectURL(item.preview)
		setStaged([])
		setCaption("")
	}

	function removeStaged(id: string) {
		setStaged((prev) => {
			const target = prev.find((item) => item.id === id)
			if (target && target.preview) URL.revokeObjectURL(target.preview)
			return prev.filter((item) => item.id !== id)
		})
	}

	async function sendStaged(options: SendOptions = {}) {
		if (staged.length === 0 || disabled) return
		const items = staged.map((item) => ({ file: item.file, spoiler: item.spoiler }))
		const cap = caption.trim()
		clearStaged()
		// The caption belongs to the first file, the way an album behaves.
		for (let i = 0; i < items.length; i++) {
			await onAttach(items[i].file, i === 0 ? cap : "", { ...options, spoiler: items[i].spoiler })
		}
	}

	function toggleSpoiler(id: string) {
		setStaged((prev) => prev.map((item) => (item.id === id ? { ...item, spoiler: !item.spoiler } : item)))
	}

	const canSpoil = (file: File) => file.type.indexOf("image/") === 0 || file.type.indexOf("video/") === 0

	const mentionMatches = mentionQuery === null
		? []
		: mentions
			.filter((item) => {
				const q = mentionQuery.toLowerCase()
				return q === "" || item.username.toLowerCase().startsWith(q) || item.displayName.toLowerCase().startsWith(q)
			})
			.slice(0, 6)

	function refreshMentionQuery(text: string, caret: number) {
		if (mentions.length === 0) {
			setMentionQuery(null)
			return
		}
		const before = text.slice(0, caret)
		const match = before.match(/(^|\s)@([A-Za-z0-9_.-]{0,32})$/)
		setMentionQuery(match ? match[2] : null)
		setMentionPick(0)
	}

	function applyMention(username: string) {
		const input = inputRef.current
		const caret = input ? input.selectionStart ?? value.length : value.length
		const before = value.slice(0, caret).replace(/@([A-Za-z0-9_.-]{0,32})$/, "@" + username + " ")
		const next = before + value.slice(caret)
		onValueChange(next)
		setMentionQuery(null)
		window.setTimeout(() => {
			const el = inputRef.current
			if (!el) return
			el.focus()
			el.selectionStart = before.length
			el.selectionEnd = before.length
		}, 0)
	}

	// Ctrl/Cmd+B and friends wrap the selection in the matching marker.
	function wrapSelection(marker: string) {
		const input = inputRef.current
		if (!input) return
		const start = input.selectionStart ?? 0
		const end = input.selectionEnd ?? 0
		if (start === end) return
		const next = value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end)
		onValueChange(next)
		window.setTimeout(() => {
			const el = inputRef.current
			if (!el) return
			el.focus()
			el.selectionStart = start + marker.length
			el.selectionEnd = end + marker.length
		}, 0)
	}

	async function submit(options: SendOptions = {}) {
		const body = value.trim()
		if (!body || disabled) return
		if (draft.editingId) {
			await onSubmitEdit(draft.editingId, body)
			return
		}
		await onSend(body, draft.replyToId, options)
	}

	// Send button: a tap sends, a long press (or right click) offers silent and
	// scheduled sending, the way M3 split buttons reveal their options.
	function pressStart(kind: "text" | "staged", event: ReactPointerEvent<HTMLButtonElement>) {
		if (event.button !== 0 && event.pointerType === "mouse") return
		pressFired.current = false
		if (pressTimer.current) window.clearTimeout(pressTimer.current)
		pressTimer.current = window.setTimeout(() => {
			pressFired.current = true
			setSendMenu(kind)
		}, 450)
	}
	function pressEnd() {
		if (pressTimer.current) window.clearTimeout(pressTimer.current)
		pressTimer.current = null
	}

	const sendMenuItems = (kind: "text" | "staged"): MenuItemSpec[] => [
		{ key: "silent", label: t("sendSilently"), icon: <ISilent size={20} />, onSelect: () => void (kind === "text" ? submit({ silent: true }) : sendStaged({ silent: true })) },
		{ key: "schedule", label: t("scheduleMessage"), icon: <ISchedule size={20} />, onSelect: () => setScheduleFor(kind) },
	]

	const attachItems: MenuItemSpec[] = [
		{ key: "media", label: t("attachMedia"), icon: <IImage size={20} />, onSelect: () => mediaRef.current?.click() },
		{ key: "file", label: t("attachFile"), icon: <IFile size={20} />, onSelect: () => fileRef.current?.click() },
		...(onSendLocation ? [{ key: "location", label: t("attachLocation"), icon: <ILocation size={20} />, onSelect: () => setSheet("location") }] : []),
		...(onSendContact ? [{ key: "contact", label: t("attachContact"), icon: <IContact size={20} />, onSelect: () => setSheet("contact") }] : []),
		...(!draft.editingId ? [{ key: "poll", label: t("poll"), icon: <IPoll size={20} />, onSelect: () => { if (attachRef.current) onCreatePoll(attachRef.current) } }] : []),
	]

	function trackSelection() {
		const el = inputRef.current
		if (!el) return
		const start = el.selectionStart ?? 0
		const end = el.selectionEnd ?? 0
		setSelection(end > start ? { start, end } : null)
	}

	function wrapWith(marker: string) {
		wrapSelection(marker)
		setSelection(null)
	}

	const commandMatches = commands.length > 0 && /^\/[a-z0-9_]*$/i.test(value) ? commands.filter((item) => item.command.startsWith(value.slice(1).toLowerCase())).slice(0, 8) : []

	function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
		if (mentionQuery !== null && mentionMatches.length > 0) {
			if (e.key === "ArrowDown") { e.preventDefault(); setMentionPick((v) => (v + 1) % mentionMatches.length); return }
			if (e.key === "ArrowUp") { e.preventDefault(); setMentionPick((v) => (v - 1 + mentionMatches.length) % mentionMatches.length); return }
			if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionMatches[mentionPick].username); return }
			if (e.key === "Escape") { e.preventDefault(); setMentionQuery(null); return }
		}
		if ((e.ctrlKey || e.metaKey) && !e.altKey) {
			const key = e.key.toLowerCase()
			if (e.shiftKey && key === "p") { e.preventDefault(); wrapSelection("||"); return }
			if (key === "b") { e.preventDefault(); wrapSelection("*"); return }
			if (key === "i") { e.preventDefault(); wrapSelection("_"); return }
			if (key === "e") { e.preventDefault(); wrapSelection("`"); return }
		}
		if (e.key === "Escape") {
			e.preventDefault()
			onValueChange("")
			onCancelDraft()
			return
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault()
			void submit()
		}
	}

	function insertEmoji(emoji: string) {
		if (staged.length > 0) {
			setCaption((c) => c + emoji)
		} else {
			onValueChange(value + emoji)
			onTyping()
		}
		inputRef.current?.focus()
	}

	const banner = draft.editingId
		? { label: t("editing"), body: draft.editingText }
		: draft.replyToId
			? { label: t("replyingTo"), body: draft.replyToText }
			: null
	const attachTitle = t("attachHint") + " " + MAX_ATTACHMENT_MB + " MB"

	return (
		<div className="composer-wrap">
			{banner ? (
				<div className="composer-banner">
					<div className="composer-banner-text">
						<span className="composer-banner-label">{banner.label}</span>
						{banner.body ? <span className="composer-banner-body">{banner.body}</span> : null}
					</div>
					<button className="button ghost small" onClick={() => { onValueChange(""); onCancelDraft() }}>{t("cancel")}</button>
				</div>
			) : null}
			{mentionQuery !== null && mentionMatches.length > 0 ? (
				<div className="mention-popup" role="listbox">
					{mentionMatches.map((item, index) => (
						<button
							key={item.username}
							type="button"
							role="option"
							aria-selected={index === mentionPick}
							className={"mention-option" + (index === mentionPick ? " active" : "")}
							onMouseDown={(event) => { event.preventDefault(); applyMention(item.username) }}
						>
							<span className="mention-name">{item.displayName}</span>
							<span className="mention-handle">@{item.username}</span>
						</button>
					))}
				</div>
			) : null}
			{commandMatches.length > 0 ? (
				<div className="mention-popup command-popup" role="listbox">
					{commandMatches.map((item) => (
						<button key={item.command} type="button" role="option" aria-selected={false} className="mention-option" onMouseDown={(event) => { event.preventDefault(); onValueChange("/" + item.command + " "); inputRef.current?.focus() }}>
							<span className="mention-name">/{item.command}</span>
							<span className="mention-handle">{item.description}</span>
						</button>
					))}
				</div>
			) : null}
			{selection && staged.length === 0 && !recording ? (
				<div className="format-toolbar" role="toolbar" aria-label={t("formatting")} onMouseDown={(event) => event.preventDefault()}>
					<button type="button" className="format-btn" onClick={() => wrapWith("*")} title={t("formatBold")} aria-label={t("formatBold")}><b>B</b></button>
					<button type="button" className="format-btn" onClick={() => wrapWith("_")} title={t("formatItalic")} aria-label={t("formatItalic")}><i>I</i></button>
					<button type="button" className="format-btn" onClick={() => wrapWith("~")} title={t("formatStrike")} aria-label={t("formatStrike")}><s>S</s></button>
					<button type="button" className="format-btn" onClick={() => wrapWith("`")} title={t("formatCode")} aria-label={t("formatCode")}><code>{"</>"}</code></button>
					<button type="button" className="format-btn spoiler" onClick={() => wrapWith("||")} title={t("formatSpoiler")} aria-label={t("formatSpoiler")}><ISpoiler size={18} /><span>{t("formatSpoiler")}</span></button>
				</div>
			) : null}
			{showEmoji ? (
				<div className="emoji-popover">
					<EmojiPanel
						full
						onPickEmoji={(emoji) => insertEmoji(emoji)}
						onPickSticker={(sticker) => { setShowEmoji(false); if (onSendSticker) void onSendSticker(sticker) }}
						onSendGif={(url) => { setShowEmoji(false); if (onSendGif) void onSendGif(url) }}
						onClose={() => setShowEmoji(false)}
					/>
				</div>
			) : null}
			{createElement("input", { ref: fileRef, type: "file", multiple: true, style: { display: "none" }, onChange: onPickFile })}
			{createElement("input", { ref: mediaRef, type: "file", multiple: true, accept: "image/*,video/*", style: { display: "none" }, onChange: onPickFile })}
			{staged.length > 0 ? (
				<div className="composer composer-attachment">
					<div className="composer-attachment-preview">
						{staged.map((item) => (
							<span key={item.id} className={"staged-item" + (item.spoiler ? " spoiler" : "")}>
								{item.preview ? <img src={item.preview} alt={item.file.name} /> : <span className="composer-attachment-file">{item.file.name}</span>}
								{canSpoil(item.file) ? (
									<button type="button" className={"staged-spoiler" + (item.spoiler ? " on" : "")} onClick={() => toggleSpoiler(item.id)} title={t("spoilerToggle")} aria-label={t("spoilerToggle")} aria-pressed={item.spoiler}>
										<IEyeOff size={14} />
									</button>
								) : null}
								<button type="button" className="staged-remove" onClick={() => removeStaged(item.id)} title={t("cancel")} aria-label={t("cancel") + ": " + item.file.name}>
									<IconClose size={12} />
								</button>
							</span>
						))}
					</div>
					<textarea className="input composer-input" rows={1} placeholder={t("addCaption")} value={caption} disabled={disabled} onChange={(e) => setCaption(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendStaged() } else if (e.key === "Escape") { e.preventDefault(); clearStaged() } }} />
					<button type="button" className="composer-icon-btn" onClick={clearStaged} title={t("cancel")} aria-label={t("cancel")}><IconClose /></button>
					<button
						ref={sendRef}
						type="button"
						className="composer-send"
						disabled={disabled}
						onPointerDown={(event) => pressStart("staged", event)}
						onPointerUp={pressEnd}
						onPointerLeave={pressEnd}
						onContextMenu={(event) => { event.preventDefault(); setSendMenu("staged") }}
						onClick={() => { if (pressFired.current) { pressFired.current = false; return } void sendStaged() }}
						title={t("send") + " · " + t("sendOptionsHint")}
						aria-label={t("send")}
					>
						<IconSend />
					</button>
				</div>
			) : recording ? (
				<div className="composer composer-recording">
					<button type="button" className="composer-icon-btn rec-discard" onClick={cancelRecording} title={t("discardRecording")} aria-label={t("discardRecording")}>
						<IconTrash />
					</button>
					<div className="rec-state">
						<span className="rec-dot" aria-hidden="true" />
						<span className="rec-time">{formatDuration(elapsed)}</span>
						<span className="rec-meter" aria-label={t("recording")}>
							{Array.from({ length: METER_BARS }).map((_unused, index) => {
								const level = levels[levels.length - METER_BARS + index]
								const height = Math.max(4, Math.round(((level ?? 0) / 100) * 22))
								return <span key={index} className="rec-meter-bar" style={{ height: height + "px" }} />
							})}
						</span>
					</div>
					<button type="button" className="composer-send" onClick={() => void finishRecording()} title={t("sendVoice")} aria-label={t("sendVoice")}>
						<IconSend />
					</button>
				</div>
			) : (
				<div className="composer">
					<button ref={attachRef} type="button" className={"composer-icon-btn" + (attachMenu ? " active" : "")} disabled={disabled} title={attachTitle} aria-label={t("attach")} aria-haspopup="menu" aria-expanded={attachMenu} onClick={() => setAttachMenu((v) => !v)}>
						<IconPaperclip />
					</button>
					<button type="button" className={"composer-icon-btn" + (showEmoji ? " active" : "")} disabled={disabled} title={t("emojiTab")} aria-label={t("emojiTab")} onClick={() => setShowEmoji((v) => !v)}>
						<IconEmoji />
					</button>
					<textarea
						ref={inputRef}
						className="input composer-input"
						rows={1}
						placeholder={disabled ? t("cannotSend") : t("writeMessage")}
						value={value}
						disabled={disabled}
						onChange={(e) => { if (voiceError) setVoiceError(null); onValueChange(e.target.value); refreshMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length); onTyping(); trackSelection() }}
						onKeyDown={onKeyDown}
						onKeyUp={trackSelection}
						onMouseUp={trackSelection}
						onSelect={trackSelection}
						onPaste={onPaste}
						onBlur={() => window.setTimeout(() => { setMentionQuery(null); setSelection(null) }, 150)}
					/>
					{(() => {
						// One button for both roles, so switching between the microphone
						// and send flips the icon over instead of swapping elements.
						const micMode = canRecord && !value.trim() && !draft.editingId
						const sendLabel = draft.editingId ? t("save") : t("send")
						return (
							<button
								ref={sendRef}
								type="button"
								className={"composer-send composer-action" + (micMode ? " composer-mic is-mic" : " is-send")}
								disabled={disabled || (!micMode && !value.trim())}
								onPointerDown={(event) => { if (!micMode && !draft.editingId) pressStart("text", event) }}
								onPointerUp={pressEnd}
								onPointerLeave={pressEnd}
								onContextMenu={(event) => { if (!micMode && !draft.editingId) { event.preventDefault(); setSendMenu("text") } }}
								onClick={() => {
									if (pressFired.current) { pressFired.current = false; return }
									if (micMode) void startRecording()
									else void submit()
								}}
								title={micMode ? t("recordVoice") : sendLabel + (draft.editingId ? "" : " · " + t("sendOptionsHint"))}
								aria-label={micMode ? t("recordVoice") : sendLabel}
							>
								<span className="flip-card" aria-hidden="true">
									<span className="flip-face flip-front"><IconMic /></span>
									<span className="flip-face flip-back"><IconSend /></span>
								</span>
							</button>
						)
					})()}
				</div>
			)}
			<div className={"composer-hint" + (voiceError ? " composer-hint-error" : "")}>{voiceError ?? attachTitle}</div>
			{attachMenu ? <Menu anchor={attachRef.current} items={attachItems} onClose={() => setAttachMenu(false)} align="start" placement="above" /> : null}
			{sendMenu ? <Menu anchor={sendRef.current} items={sendMenuItems(sendMenu)} onClose={() => setSendMenu(null)} align="end" placement="above" /> : null}
			{scheduleFor ? (
				<ScheduleSheet
					onClose={() => setScheduleFor(null)}
					onPick={(sendAt, silent) => {
						const kind = scheduleFor
						setScheduleFor(null)
						if (kind === "text") void submit({ sendAt, silent })
						else void sendStaged({ sendAt, silent })
					}}
				/>
			) : null}
			{sheet === "location" && onSendLocation ? <LocationSheet onClose={() => setSheet(null)} onSend={(location) => void onSendLocation(location)} /> : null}
			{sheet === "contact" && onSendContact ? <ContactSheet onClose={() => setSheet(null)} onSend={(contact) => void onSendContact(contact)} /> : null}
		</div>
	)
}
