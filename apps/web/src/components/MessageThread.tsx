import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react"
import type { DisplayMessage, Reaction, PollSummary, ConversationMember } from "../lib/types"
import { REACTION_SET } from "../lib/reactions"
import { isAnimatedMedia, isAudioMedia, isVideoMedia, type MediaEnvelope } from "../lib/media"
import { formatDate, formatTimeOfDay, type Lang, type StringKey } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { PollCard } from "./PollCard"
import { EmojiPanel, frequentEmoji, noteEmojiUsed } from "./EmojiPanel"
import { IconEmoji, IconReply, IconForward, IconMore, IconFile } from "./Icons"
import { formatDuration, WAVEFORM_BARS } from "../lib/voice"
import { renderRichText, stripFormatting } from "../lib/richtext"
import { LoadingBlock, LoadingIndicator, MorphBlob, WavyCircle, WavyProgress } from "./Expressive"
import type { PendingUpload } from "../routes/Chat"
import { ContactBubble, LocationBubble } from "./RichBubbles"
import { IBellOff, IBot, IChat, ICopy, IDownload, IEdit, IEyeOff, IForward, ILink, IPin, IPinOff, IReply, ISmilePlus, ITrash } from "./m3icons"
import { Menu, type MenuItemSpec } from "./m3"
import { useContextMenuGesture } from "../lib/longpress"
import type { BotButton } from "../lib/botmsg"
const SENDER_COLORS = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#f2a45c"]
function senderColor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return SENDER_COLORS[hash % SENDER_COLORS.length]
}
function senderInitials(label: string): string {
	const parts = label.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return "?"
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
	return (parts[0][0] + parts[1][0]).toUpperCase()
}

// Day separators: one island before the first message of a day, the way a
// phone messenger does it. Today and yesterday are named; anything older shows
// its date, with the year only when it is not the current one.
function dayKey(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ""
	return String(date.getFullYear()) + "-" + String(date.getMonth()) + "-" + String(date.getDate())
}

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayLabel(iso: string, lang: Lang, t: (key: StringKey) => string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ""
	const now = new Date()
	const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
	if (days === 0) return t("today")
	if (days === 1) return t("yesterday")
	const sameYear = date.getFullYear() === now.getFullYear()
	return formatDate(lang, date, sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })
}

function formatBytes(size: number): string {
	if (!size || size < 0) return ""
	if (size < 1024) return size + " B"
	if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB"
	return (size / (1024 * 1024)).toFixed(1) + " MB"
}

function triggerDownload(url: string, name: string) {
	const link = document.createElement("a")
	link.href = url
	link.download = name || "file"
	document.body.appendChild(link)
	link.click()
	link.remove()
}

function popoverStyle(anchor: HTMLElement, mine: boolean, estHeight: number, estWidth = 200): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const margin = 8
  const gap = 6
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(estWidth, vw - margin * 2)
  const spaceBelow = vh - rect.bottom - margin
  const spaceAbove = rect.top - margin
  // Flip above only when there is not enough room below and there is genuinely
  // more room above, so the popover hugs the button instead of drifting.
  const placeAbove = spaceBelow < Math.min(estHeight, 260) && spaceAbove > spaceBelow
  let left = mine ? rect.right - width : rect.left
  if (left + width > vw - margin) left = vw - margin - width
  if (left < margin) left = margin
  const style: CSSProperties = {
    position: "fixed",
    left: Math.round(left),
    right: "auto",
    maxWidth: Math.round(width),
  }
  if (placeAbove) {
    // Anchor the BOTTOM edge just above the button; it then grows upward by its
    // real height, so a short menu no longer floats far above the button.
    style.bottom = Math.round(vh - rect.top + gap)
    style.top = "auto"
    style.maxHeight = Math.max(120, Math.round(spaceAbove - gap))
  } else {
    style.top = Math.round(rect.bottom + gap)
    style.bottom = "auto"
    style.maxHeight = Math.max(120, Math.round(spaceBelow - gap))
  }
  return style
}

type Grouped = { emoji: string; count: number; mine: boolean }

function groupReactions(list: Reaction[], currentUserId: string): Grouped[] {
	const map = new Map<string, Grouped>()
	for (const reaction of list) {
		const entry = map.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false }
		entry.count += 1
		if (reaction.userId === currentUserId) entry.mine = true
		map.set(reaction.emoji, entry)
	}
	return Array.from(map.values())
}

// Only one voice message plays at a time, the way a phone messenger behaves:
// starting one stops whichever was running.
let playingVoice: HTMLAudioElement | null = null

function VoiceBlock(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null> }) {
	const { t } = useSettings()
	const audioRef = useRef<HTMLAudioElement | null>(null)
	const [url, setUrl] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)
	const [busy, setBusy] = useState(false)
	const [playing, setPlaying] = useState(false)
	const [position, setPosition] = useState(0)
	const [speed, setSpeed] = useState(1)
	// Voice notes sent by an older client carry no duration; fall back to what
	// the audio element reports once it has metadata.
	const [measured, setMeasured] = useState(0)
	const total = props.media.duration && props.media.duration > 0 ? props.media.duration : measured
	const bars = props.media.waveform && props.media.waveform.length > 0
		? props.media.waveform
		: new Array(WAVEFORM_BARS).fill(28)
	const progress = total > 0 ? Math.max(0, Math.min(1, position / total)) : 0

	// The audio is fetched and decrypted on the first play, so opening a chat
	// full of voice notes does not download every one of them.
	const ensureUrl = useCallback(async (): Promise<string | null> => {
		if (url) return url
		setBusy(true)
		try {
			const resolved = await props.onResolveMedia(props.media)
			setUrl(resolved)
			if (!resolved) setFailed(true)
			return resolved
		} catch {
			setFailed(true)
			return null
		} finally {
			setBusy(false)
		}
	}, [url, props.media.fileId])

	async function toggle() {
		const element = audioRef.current
		if (element && playing) {
			element.pause()
			return
		}
		const resolved = await ensureUrl()
		if (!resolved) return
		const target = audioRef.current
		if (!target) return
		target.playbackRate = speed
		if (playingVoice && playingVoice !== target) playingVoice.pause()
		try {
			await target.play()
			playingVoice = target
		} catch {
			setFailed(true)
		}
	}

	async function seek(event: ReactMouseEvent<HTMLDivElement>) {
		if (total <= 0) return
		const rect = event.currentTarget.getBoundingClientRect()
		const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
		const resolved = await ensureUrl()
		if (!resolved) return
		const target = audioRef.current
		if (!target) return
		target.currentTime = ratio * total
		setPosition(ratio * total)
	}

	function cycleSpeed() {
		const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1
		setSpeed(next)
		if (audioRef.current) audioRef.current.playbackRate = next
	}

	if (failed) {
		return <div className="media-status">{t("voiceUnavailable")}</div>
	}

	return (
		<div className="voice-card">
			<button type="button" className={"voice-play" + (playing ? " is-playing" : "")} onClick={() => void toggle()} disabled={busy} title={playing ? t("pause") : t("play")} aria-label={playing ? t("pause") : t("play")}>
				{busy ? (
					<WavyCircle size={40} className="voice-busy" />
				) : playing ? (
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
						<rect x="7" y="5" width="3.6" height="14" rx="1.2" />
						<rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
					</svg>
				) : (
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
						<path d="M8 5.6a1 1 0 0 1 1.52-.86l9 6.4a1 1 0 0 1 0 1.72l-9 6.4A1 1 0 0 1 8 18.4z" />
					</svg>
				)}
			</button>
			<div className="voice-main">
				<div className="voice-wave" role="presentation" onClick={(event) => void seek(event)}>
					{bars.map((value, index) => (
						<span
							key={index}
							className={"voice-bar" + (index / bars.length < progress ? " played" : "")}
							style={{ height: Math.max(3, Math.round((value / 100) * 22)) + "px" }}
						/>
					))}
				</div>
				<div className="voice-meta">
					<span className="voice-time">{formatDuration(playing || position > 0 ? position : total)}</span>
					<button type="button" className="voice-speed" onClick={cycleSpeed} title={t("playbackSpeed")} aria-label={t("playbackSpeed")}>
						{speed === 1 ? "1x" : speed === 1.5 ? "1.5x" : "2x"}
					</button>
				</div>
			</div>
			{url ? (
				<audio
					ref={audioRef}
					src={url}
					preload="metadata"
					onLoadedMetadata={(event) => {
						const value = event.currentTarget.duration
						if (Number.isFinite(value) && value > 0) setMeasured(value)
					}}
					onPlay={(event) => { playingVoice = event.currentTarget; setPlaying(true) }}
					onPause={() => setPlaying(false)}
					onEnded={(event) => { if (playingVoice === event.currentTarget) playingVoice = null; setPlaying(false); setPosition(0) }}
					onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
					onError={() => { setPlaying(false); setFailed(true) }}
				/>
			) : null}
		</div>
	)
}

// Video and non-voice audio are fetched only when the viewer asks for them:
// the blob is encrypted end to end, so playing means downloading and decrypting
// the whole file, and doing that for every clip in a chat would be wasteful.
function VideoBlock(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onExpand?: () => void }) {
	const { t } = useSettings()
	const [url, setUrl] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [progress, setProgress] = useState(0)
	const [failed, setFailed] = useState(false)
	const [unsupported, setUnsupported] = useState(false)
	const width = props.media.width && props.media.width > 0 ? props.media.width : null
	const height = props.media.height && props.media.height > 0 ? props.media.height : null
	const ratio = width && height ? width + " / " + height : "16 / 9"

	async function load() {
		if (loading || url) return
		setLoading(true)
		setProgress(0)
		try {
			const resolved = await props.onResolveMedia(props.media, (value) => setProgress(value))
			if (resolved) setUrl(resolved)
			else setFailed(true)
		} catch {
			setFailed(true)
		} finally {
			setLoading(false)
		}
	}

	if (failed) return <div className="media-status">{t("videoUnavailable")}</div>

	if (url) {
		return (
			<div className="video-wrap">
				{props.onExpand ? (
					<button type="button" className="video-expand" onClick={props.onExpand} title={t("openFull")} aria-label={t("openFull")}>
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="M9 4H4v5" /><path d="M15 20h5v-5" /><path d="M4 4l6 6" /><path d="M20 20l-6-6" />
						</svg>
					</button>
				) : null}
				{unsupported ? (
					<div className="media-status">{t("videoUnsupported")}</div>
				) : (
					<video
						className="bubble-video"
						src={url}
						controls
						autoPlay
						playsInline
						preload="metadata"
						style={{ aspectRatio: ratio }}
						onError={() => setUnsupported(true)}
					/>
				)}
			</div>
		)
	}

	return (
		<div className="video-wrap">
				{props.onExpand ? (
					<button type="button" className="video-expand" onClick={props.onExpand} title={t("openFull")} aria-label={t("openFull")}>
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="M9 4H4v5" /><path d="M15 20h5v-5" /><path d="M4 4l6 6" /><path d="M20 20l-6-6" />
						</svg>
					</button>
				) : null}
			<button
				type="button"
				className="video-poster"
				style={{ aspectRatio: ratio }}
				onClick={() => void load()}
				disabled={loading}
				title={t("playVideo")}
				aria-label={t("playVideo") + ": " + props.media.name}
			>
				{props.media.poster ? <img className="video-poster-img" src={props.media.poster} alt="" /> : <span className="video-poster-blank" aria-hidden="true" />}
				<span className="video-poster-shade" aria-hidden="true" />
				{loading ? (
					<span className="video-progress"><WavyCircle value={progress > 0 ? progress : null} size={56} label={t("loadingImage")}>{progress > 0 ? Math.round(progress * 100) : null}</WavyCircle></span>
				) : (
					<span className="video-play" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
							<path d="M8 5.6a1 1 0 0 1 1.52-.86l9 6.4a1 1 0 0 1 0 1.72l-9 6.4A1 1 0 0 1 8 18.4z" />
						</svg>
					</span>
				)}
				<span className="video-badges">
					{props.media.duration && props.media.duration > 0 ? <span className="video-badge">{formatDuration(props.media.duration)}</span> : null}
					<span className="video-badge">{formatBytes(props.media.size)}</span>
				</span>
			</button>
		</div>
	)
}

function AudioBlock(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null> }) {
	const { t } = useSettings()
	const [url, setUrl] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [progress, setProgress] = useState(0)
	const [failed, setFailed] = useState(false)

	async function load() {
		if (loading || url) return
		setLoading(true)
		setProgress(0)
		try {
			const resolved = await props.onResolveMedia(props.media, (value) => setProgress(value))
			if (resolved) setUrl(resolved)
			else setFailed(true)
		} catch {
			setFailed(true)
		} finally {
			setLoading(false)
		}
	}

	if (failed) return <div className="media-status">{t("audioUnavailable")}</div>

	return (
		<div className="audio-card">
			<div className="audio-card-head">
				{url ? null : (
					<button type="button" className="voice-play" onClick={() => void load()} disabled={loading} title={t("play")} aria-label={t("play") + ": " + props.media.name}>
						{loading ? (
							<WavyCircle value={progress > 0 ? progress : null} size={40} className="audio-progress" label={t("loadingImage")} />
						) : (
							<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
								<path d="M8 5.6a1 1 0 0 1 1.52-.86l9 6.4a1 1 0 0 1 0 1.72l-9 6.4A1 1 0 0 1 8 18.4z" />
							</svg>
						)}
					</button>
				)}
				<div className="file-card-main">
					<div className="file-card-name">{props.media.name}</div>
					<div className="file-card-sub">{formatBytes(props.media.size)}</div>
				</div>
			</div>
			{url ? <audio className="audio-player" src={url} controls autoPlay preload="metadata" onError={() => setFailed(true)} /> : null}
		</div>
	)
}

function LinkCard(props: { card: NonNullable<DisplayMessage["link"]> }) {
	const { card } = props
	return (
		<a className="link-card" href={card.url} target="_blank" rel="noreferrer noopener">
			{card.image ? <img className="link-card-image" src={card.image} alt="" /> : null}
			<span className="link-card-body">
				{card.siteName ? <span className="link-card-site">{card.siteName}</span> : null}
				{card.title ? <span className="link-card-title">{card.title}</span> : null}
				{card.description ? <span className="link-card-text">{card.description}</span> : null}
			</span>
		</a>
	)
}

// Photos and videos sent as spoilers stay blurred under moving noise until
// tapped; the viewer opens only after that.
function SpoilerCover(props: { onReveal: () => void; poster?: string | null }) {
	const { t } = useSettings()
	return (
		<button type="button" className="media-spoiler" onClick={(event) => { event.stopPropagation(); props.onReveal() }} aria-label={t("spoilerReveal")}>
			{props.poster ? <img className="media-spoiler-poster" src={props.poster} alt="" /> : null}
			<span className="media-spoiler-noise" aria-hidden="true" />
			<span className="media-spoiler-label"><IEyeOff size={16} /> {t("spoilerLabel")}</span>
		</button>
	)
}

function MediaBlock(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onOpenViewer?: () => void }) {
	const [revealed, setRevealed] = useState(!props.media.spoiler)
	if (!revealed) {
		const isVisual = props.media.kind === "image" || isVideoMedia(props.media)
		if (isVisual) {
			const ratio = props.media.width && props.media.height ? props.media.width + " / " + props.media.height : "4 / 3"
			return (
				<div className="media-image-wrap spoiler-wrap" style={{ aspectRatio: ratio }}>
					<SpoilerCover onReveal={() => setRevealed(true)} poster={props.media.poster} />
				</div>
			)
		}
	}
	return <MediaBlockInner {...props} />
}

function MediaBlockInner(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onOpenViewer?: () => void }) {
	const { t } = useSettings()
	const [url, setUrl] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)
	const isVoice = props.media.kind === "voice"
	const isImage = props.media.kind === "image"
	const isVideo = isVideoMedia(props.media)
	// A GIF from the picker keeps looping on its own; a real video gets a player.
	const isLoopingClip = isVideo && isAnimatedMedia(props.media)
	const isAudio = !isVoice && isAudioMedia(props.media)

	useEffect(() => {
		if (!isImage && !isLoopingClip) return
		let active = true
		const run = async () => {
			try {
				const resolved = await props.onResolveMedia(props.media)
				if (active) setUrl(resolved)
			} catch {
				if (active) setFailed(true)
			}
		}
		void run()
		return () => {
			active = false
		}
	}, [props.media.fileId, isImage, isLoopingClip])

	if (isVoice) {
		return <VoiceBlock media={props.media} onResolveMedia={props.onResolveMedia} />
	}
	if (isLoopingClip) {
		return (
			<div className="media-image-wrap">
				{failed ? (
					<div className="media-status">{t("imageUnavailable")}</div>
				) : url ? (
					<video src={url} className="bubble-image" autoPlay loop muted playsInline />
				) : (
					<div className="media-status media-loading"><LoadingIndicator size={36} label={t("loadingImage")} /></div>
				)}
			</div>
		)
	}
	if (isVideo) {
		return <VideoBlock media={props.media} onResolveMedia={props.onResolveMedia} onExpand={props.onOpenViewer} />
	}
	if (isAudio) {
		return <AudioBlock media={props.media} onResolveMedia={props.onResolveMedia} />
	}
	if (isImage) {
		return (
			<div className="media-image-wrap">
				{failed ? (
					<div className="media-status">{t("imageUnavailable")}</div>
				) : url ? (
					<img
						src={url}
						alt={props.media.name}
						className={"bubble-image" + (props.onOpenViewer ? " clickable" : "")}
						onClick={props.onOpenViewer}
						role={props.onOpenViewer ? "button" : undefined}
					/>
				) : (
					<div className="media-status media-loading"><LoadingIndicator size={36} label={t("loadingImage")} /></div>
				)}
			</div>
		)
	}

	return (
		<div className="file-card">
			<div className="file-card-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<path d="M14 2v6h6" />
				</svg>
			</div>
			<div className="file-card-main">
				<div className="file-card-name">{props.media.name}</div>
				<div className="file-card-sub">{formatBytes(props.media.size)}</div>
			</div>
		</div>
	)
}

function ReplyPreview(props: { parent: DisplayMessage; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onJump: () => void }) {
	const { t } = useSettings()
	const [thumb, setThumb] = useState<string | null>(null)
	const media = props.parent.media
	const isImage = Boolean(media && media.kind === "image" && !media.spoiler && !props.parent.locked && !props.parent.deleted)
	useEffect(() => {
		if (!isImage || !media) return
		let active = true
		void props.onResolveMedia(media).then((url) => { if (active) setThumb(url) }).catch(() => {})
		return () => { active = false }
	}, [isImage, media ? media.fileId : ""])
	const label = props.parent.locked
		? t("messageEncrypted")
		: props.parent.poll
			? t("pollShort")
			: props.parent.location
				? t("locationShort")
				: props.parent.contact
					? t("contactShort") + " " + props.parent.contact.displayName
			: media
				? media.kind === "image" ? t("photo") : media.kind === "voice" ? t("voiceMessage") : (media.name || t("file"))
				: (() => {
					const plain = stripFormatting(props.parent.text ?? "")
					return plain.length > 60 ? plain.slice(0, 60) + "..." : plain
				})()
	return (
		<div className="bubble-reply" role="button" tabIndex={0} onClick={props.onJump}>
			{isImage && thumb ? <img className="reply-thumb" src={thumb} alt="" /> : null}
			{!isImage && media ? <span className="reply-file-icon" aria-hidden="true"><IconFile size={14} /></span> : null}
			<span className="reply-preview-text">{label}</span>
		</div>
	)
}

// Buttons under a bot's message, in the rows the bot chose. A pressed button
// waits (with a spinner) until the bot answers; link buttons show an arrow.
function BotButtons(props: { rows: BotButton[][]; onPress: (button: BotButton) => Promise<void> }) {
	const [busy, setBusy] = useState<string | null>(null)
	return (
		<div className="bot-buttons" role="group">
			{props.rows.map((row, r) => (
				<div className="bot-buttons-row" key={r}>
					{row.map((button, i) => {
						const key = r + ":" + i
						return (
							<button
								key={key}
								type="button"
								className={"bot-button" + (busy === key ? " busy" : "")}
								disabled={busy !== null && !button.url}
								title={button.url ? button.url : undefined}
								onClick={(event) => {
									event.stopPropagation()
									if (button.url) {
										void props.onPress(button)
										return
									}
									setBusy(key)
									void props.onPress(button).finally(() => setBusy(null))
								}}
							>
								<span className="bot-button-text">{button.text}</span>
								{busy === key ? <LoadingIndicator size={16} /> : button.url ? <ILink size={14} /> : null}
							</button>
						)
					})}
				</div>
			))}
		</div>
	)
}

function TickMark(props: { read: boolean }) {
	const marks: any[] = [createElement("polyline", { key: "a", points: "2.5 8.5 5.5 11.5 11 5.5" })]
	if (props.read) marks.push(createElement("polyline", { key: "b", points: "7.5 11.5 13 5.5" }))
	return createElement("span", { className: "read-ticks" + (props.read ? " read" : "") }, createElement("svg", { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" }, marks))
}
export function MessageThread({
	messages: allMessages,
	reactions,
	currentUserId,
members = [],
	loading,
	hasMore,
	loadingOlder,
	typingLabel,
	onLoadOlder,
	onReply,
	onEdit,
	onDelete,
	onToggleReaction,
	onResolveMedia,
	onOpenViewer,
	onOpenPinnedList,
	jumpToId = null,
	onJumpHandled,
	pinnedIds,
	canModerate,
	onTogglePin,
	onForward,
	isChannel,
	onOpenComments,
	pollsByMessage,
	canClosePoll,
	onVotePoll,
	onClosePoll,
	isSelf = false,
	readIds = null,
	conversationId = null,
	pending = [],
	queued = [],
	hasNewer = false,
	loadingNewer = false,
	onLoadNewer,
	onMessageContact,
	onBotButton,
}: {
	messages: DisplayMessage[]
	reactions: Reaction[]
	currentUserId: string
	readIds?: any
members?: ConversationMember[]
	loading: boolean
	hasMore: boolean
	loadingOlder: boolean
	typingLabel: string | null
	onLoadOlder: () => void
	onReply: (message: DisplayMessage) => void
	onEdit: (message: DisplayMessage) => void
	onDelete: (message: DisplayMessage) => void
	onToggleReaction: (messageId: string, emoji: string, active: boolean) => void
	onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>
	onOpenViewer?: (messageId: string) => void
	onOpenPinnedList?: () => void
	jumpToId?: string | null
	onJumpHandled?: () => void
	pinnedIds: Set<string>
	canModerate: boolean
	onTogglePin: (messageId: string, active: boolean) => void
	onForward: (message: DisplayMessage) => void
	isChannel: boolean
	onOpenComments: (message: DisplayMessage) => void
	pollsByMessage: Map<string, PollSummary>
	canClosePoll: boolean
	onVotePoll: (messageId: string, optionIndexes: number[]) => Promise<void>
	onClosePoll: (messageId: string) => Promise<void>
	isSelf?: boolean
	conversationId?: string | null
	pending?: PendingUpload[]
	queued?: Array<{ id: string; body: string; createdAt: string }>
	hasNewer?: boolean
	loadingNewer?: boolean
	onLoadNewer?: () => void
	onMessageContact?: (username: string) => void
	onBotButton?: (message: DisplayMessage, button: BotButton) => Promise<void>
}) {
	const { t, lang } = useSettings()
	// Deleted messages leave the chat instead of turning into a notice: one that
	// was on screen plays a short exit, the rest are simply not drawn.
	const seenAliveRef = useRef(new Set<string>())
	const lastAliveRef = useRef(new Map<string, DisplayMessage>())
	const [leaving, setLeaving] = useState<Set<string>>(() => new Set())
	const goneRef = useRef(new Set<string>())
	useEffect(() => {
		const start: string[] = []
		for (const message of allMessages) {
			if (!message.deleted) {
				seenAliveRef.current.add(message.id)
				lastAliveRef.current.set(message.id, message)
				continue
			}
			if (seenAliveRef.current.has(message.id) && !goneRef.current.has(message.id)) start.push(message.id)
		}
		if (start.length === 0) return
		// Marked gone at once so a re-render cannot start the exit twice; the
		// timer is not tied to this render, so the row always goes away.
		for (const id of start) goneRef.current.add(id)
		setLeaving((prev) => new Set([...prev, ...start]))
		window.setTimeout(() => {
			setLeaving((prev) => {
				const next = new Set(prev)
				for (const id of start) next.delete(id)
				return next
			})
		}, 420)
	}, [allMessages])
	// While it leaves, a message keeps the look it had.
	const messages = useMemo(
		() => allMessages.filter((message) => !message.deleted || leaving.has(message.id)).map((message) => (message.deleted ? lastAliveRef.current.get(message.id) ?? message : message)),
		[allMessages, leaving],
	)
	const endRef = useRef<HTMLDivElement | null>(null)
	const lastIdRef = useRef<string | null>(null)
	const convRef = useRef<string | null>(null)
	const jumpRef = useRef(true)
	const rowRefs = useRef(new Map<string, HTMLDivElement>())
	const listRef = useRef<HTMLDivElement | null>(null)
	const firstIdRef = useRef<string | null>(null)
	const stickUntilRef = useRef(0)
	const atBottomRef = useRef(true)
	const rafRef = useRef<number | null>(null)
	const restoreRef = useRef<number | null>(null)
	// Messages that arrive while the chat is open get an entrance animation;
	// the history loaded when a chat opens (or older pages) appears as is.
	const arrivalRef = useRef<{ conv: string | null; latest: string; seen: Map<string, number> }>({ conv: null, latest: "", seen: new Map() })
	{
		const conv = messages.length > 0 ? messages[0].conversationId : null
		const state = arrivalRef.current
		if (conv !== state.conv) {
			arrivalRef.current = { conv, latest: messages.reduce((max, m) => (m.createdAt > max ? m.createdAt : max), ""), seen: new Map() }
		}
	}
	const isFreshArrival = (id: string, createdAt: string): boolean => {
		const state = arrivalRef.current
		const now = Date.now()
		let at = state.seen.get(id)
		if (at === undefined) {
			at = createdAt > state.latest ? now : 0
			state.seen.set(id, at)
		}
		return at > 0 && now - at < 900
	}
	const scrollToEnd = useCallback(() => {
		const el = listRef.current
		if (!el) return
		el.scrollTop = el.scrollHeight
	}, [])
	const holdBottom = useCallback((durationMs: number) => {
		stickUntilRef.current = Date.now() + durationMs
		scrollToEnd()
		const step = () => {
			const el = listRef.current
			if (!el) return
			if (Date.now() > stickUntilRef.current) return
			if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight
			rafRef.current = window.requestAnimationFrame(step)
		}
		if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
		rafRef.current = window.requestAnimationFrame(step)
	}, [scrollToEnd])
	const dropStick = useCallback(() => {
		stickUntilRef.current = 0
	}, [])
	const handleScroll = useCallback(() => {
		const el = listRef.current
		if (!el) return
		atBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80
	}, [])
	const handleLoadOlder = useCallback(() => {
		const el = listRef.current
		restoreRef.current = el ? el.scrollHeight - el.scrollTop : null
		stickUntilRef.current = 0
		onLoadOlder()
	}, [onLoadOlder])
	useEffect(() => {
		const el = listRef.current
		if (!el) return
		const onMedia = () => {
			if (Date.now() < stickUntilRef.current || atBottomRef.current) el.scrollTop = el.scrollHeight
		}
		el.addEventListener("load", onMedia, true)
		return () => {
			el.removeEventListener("load", onMedia, true)
			if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
		}
	}, [conversationId, messages.length === 0])
	// An upload card growing at the bottom should not push itself out of sight.
	useEffect(() => {
		if (pending.length > 0 && atBottomRef.current) scrollToEnd()
	}, [pending.length, scrollToEnd])
	// A jump asked for from outside the thread, e.g. from the pinned list.
	useEffect(() => {
		if (!jumpToId) return
		jumpToRef.current(jumpToId)
		if (onJumpHandled) onJumpHandled()
	}, [jumpToId, onJumpHandled])
	// The pinned bar is sticky at the top of the list and can wrap to two lines,
	// so the island's offset follows its real height instead of a guess.
	const pinnedBarRef = useRef<HTMLDivElement | null>(null)
	const [pinnedBarHeight, setPinnedBarHeight] = useState(0)
	useEffect(() => {
		const element = pinnedBarRef.current
		if (!element) {
			setPinnedBarHeight(0)
			return
		}
		const measure = () => setPinnedBarHeight(element.getBoundingClientRect().height)
		measure()
		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	})
	const [flashId, setFlashId] = useState<string | null>(null)
	const [menuId, setMenuId] = useState<string | null>(null)
	const [pickerId, setPickerId] = useState<string | null>(null)
	const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)

	async function downloadMedia(message: DisplayMessage) {
		if (!message.media) return
		try {
			const resolved = await onResolveMedia(message.media)
			if (resolved) triggerDownload(resolved, message.media.name)
		} catch {
			// The bubble already reports unavailable media.
		}
	}
	const [pickerStyle, setPickerStyle] = useState<CSSProperties | null>(null)
	const [contextMenu, setContextMenu] = useState<{ message: DisplayMessage; x: number; y: number } | null>(null)
	const messageGesture = useContextMenuGesture((x, y, target) => {
		const row = target?.closest?.("[data-message-id]") as HTMLElement | null
		const message = row ? byIdRef.current.get(row.dataset.messageId ?? "") : undefined
		if (!message || message.deleted) return false
		// Right click on a link keeps the browser's own menu (copy link, open).
		if (target?.closest?.("a[href]") && !("ontouchstart" in window)) return false
		setMenuId(null)
		setPickerId(null)
		setContextMenu({ message, x, y })
		return true
	})
	const byIdRef = useRef(new Map<string, DisplayMessage>())
	const flashTimerRef = useRef<number | null>(null)
	const jumpToRef = useRef<(id: string) => void>(() => undefined)
	const jumpTo = useCallback((id: string) => {
		const el = rowRefs.current.get(id)
		if (!el) return
		el.scrollIntoView({ behavior: "smooth", block: "center" })
		setFlashId(id)
		if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
		flashTimerRef.current = window.setTimeout(() => setFlashId(null), 1300)
	}, [])
	jumpToRef.current = jumpTo
	// A name is highlighted only when it belongs to someone in this chat.
	const isKnownMention = useCallback(
		(name: string) => members.some((member) => member.username.toLowerCase() === name.toLowerCase()),
		[members],
	)
	const previewText = (m: DisplayMessage): string => {
		if (m.locked) return t("messageEncrypted")
		if (m.poll) return t("pollShort")
		if (m.location) return t("locationShort")
		if (m.contact) return t("contactShort") + " " + m.contact.displayName
		if (m.media) return m.media.kind === "image" ? t("photo") : m.media.kind === "voice" ? t("voiceMessage") : (m.media.name || t("file"))
		const body = stripFormatting(m.text ?? "")
		return body.length > 60 ? body.slice(0, 60) + "..." : body
	}

	useLayoutEffect(() => {
		const last = messages.length > 0 ? messages[messages.length - 1] : null
		const lastId = last ? last.id : null
		const firstId = messages.length > 0 ? messages[0].id : null
		if (conversationId !== convRef.current) {
			convRef.current = conversationId
			lastIdRef.current = null
			firstIdRef.current = null
			restoreRef.current = null
			jumpRef.current = true
			atBottomRef.current = true
			scrollToEnd()
		}
		if (restoreRef.current !== null && firstId !== firstIdRef.current) {
			const el = listRef.current
			if (el) el.scrollTop = el.scrollHeight - restoreRef.current
			restoreRef.current = null
			firstIdRef.current = firstId
			lastIdRef.current = lastId
			return
		}
		firstIdRef.current = firstId
		if (lastId === lastIdRef.current) return
		lastIdRef.current = lastId
		if (jumpRef.current) {
			if (lastId) jumpRef.current = false
			holdBottom(1800)
			return
		}
		if (atBottomRef.current) holdBottom(600)
	}, [messages, conversationId, holdBottom, scrollToEnd])

	// One group per day: the island lives inside its group, so it sticks while
	// that day is on screen and leaves with it instead of piling up with the
	// islands of the other days.
	const dayGroups = useMemo(() => {
		const groups: Array<{ key: string; label: string; items: DisplayMessage[] }> = []
		for (const message of messages) {
			const key = dayKey(message.createdAt)
			const last = groups.length > 0 ? groups[groups.length - 1] : null
			if (!last || last.key !== key) groups.push({ key, label: dayLabel(message.createdAt, lang, t), items: [message] })
			else last.items.push(message)
		}
		return groups
	}, [messages, lang, t])

	const byMessage = new Map<string, Reaction[]>()
	for (const reaction of reactions) {
		const list = byMessage.get(reaction.messageId) ?? []
		list.push(reaction)
		byMessage.set(reaction.messageId, list)
	}
	const byId = new Map<string, DisplayMessage>()
	for (const message of messages) byId.set(message.id, message)
	byIdRef.current = byId

	const contextItems = (message: DisplayMessage): MenuItemSpec[] => {
		const mine = message.senderId === currentUserId
		const isPinned = pinnedIds.has(message.id)
		const text = message.locked ? "" : message.media ? message.media.caption ?? "" : message.text ?? ""
		return [
			{ key: "reply", label: t("reply"), icon: <IReply size={20} />, onSelect: () => onReply(message) },
			...(!message.locked ? [{ key: "forward", label: t("forward"), icon: <IForward size={20} />, onSelect: () => onForward(message) }] : []),
			...(text ? [{ key: "copy", label: t("copy"), icon: <ICopy size={20} />, onSelect: () => void navigator.clipboard?.writeText(stripFormatting(text)).catch(() => undefined) }] : []),
			...(mine && !message.poll && !message.media && !message.locked && !message.location && !message.contact ? [{ key: "edit", label: t("edit"), icon: <IEdit size={20} />, onSelect: () => onEdit(message) }] : []),
			...(canModerate ? [{ key: "pin", label: isPinned ? t("unpin") : t("pin"), icon: isPinned ? <IPinOff size={20} /> : <IPin size={20} />, onSelect: () => onTogglePin(message.id, !isPinned) }] : []),
			...(message.media && !message.locked ? [{ key: "download", label: t("download"), icon: <IDownload size={20} />, onSelect: () => void downloadMedia(message) }] : []),
			...(isChannel ? [{ key: "comments", label: t("comments"), icon: <IChat size={20} />, onSelect: () => onOpenComments(message) }] : []),
			...(mine ? [{ key: "delete", label: t("deleteAction"), icon: <ITrash size={20} />, danger: true, onSelect: () => onDelete(message) }] : []),
		]
	}
	const contextReactions = (message: DisplayMessage) => {
		const mineReactions = new Set((byMessage.get(message.id) ?? []).filter((r) => r.userId === currentUserId).map((r) => r.emoji))
		return (
			<div className="ctx-reactions">
				{frequentEmoji(7, REACTION_SET).map((emoji) => (
					<button
						key={emoji}
						type="button"
						className={"ctx-reaction" + (mineReactions.has(emoji) ? " mine" : "")}
						onClick={() => {
							setContextMenu(null)
							if (!mineReactions.has(emoji)) noteEmojiUsed(emoji)
							onToggleReaction(message.id, emoji, !mineReactions.has(emoji))
						}}
					>
						{emoji}
					</button>
				))}
				<button
					type="button"
					className="ctx-reaction more"
					aria-label={t("addReaction")}
					onClick={() => {
						const row = rowRefs.current.get(message.id)
						const bubble = (row?.querySelector(".bubble") as HTMLElement | null) ?? row
						setContextMenu(null)
						if (!bubble) return
						setPickerStyle(popoverStyle(bubble, message.senderId === currentUserId, 380, 328))
						setPickerId(message.id)
					}}
				>
					<ISmilePlus size={20} />
				</button>
			</div>
		)
	}

	const pinnedLoaded = messages.filter((m) => pinnedIds.has(m.id) && !m.deleted)
	const pinnedPreview = pinnedLoaded.length > 0 ? pinnedLoaded[pinnedLoaded.length - 1] : null

	if (loading && messages.length === 0) {
		return (
			<div className="messages">
				<LoadingBlock label={t("loadingMessages")} />
			</div>
		)
	}

	return (
		<div
			className={"messages" + (pinnedPreview ? " has-pinned" : "")}
			ref={listRef}
			onScroll={handleScroll}
			onWheel={dropStick}
			onTouchStart={dropStick}
			{...messageGesture}
			style={{ "--pinned-bar-h": String(Math.round(pinnedBarHeight)) + "px" } as CSSProperties}
		>
			{pinnedPreview ? (
				<div className="pinned-bar" ref={pinnedBarRef}>
					<button type="button" className="pinned-bar-main" onClick={() => jumpTo(pinnedPreview.id)}>
						<span className="pinned-bar-label">{t("pinnedBar")}</span>
						<span className="pinned-bar-text">{previewText(pinnedPreview)}</span>
					</button>
					{onOpenPinnedList ? (
						<button type="button" className="pinned-bar-all" onClick={onOpenPinnedList}>
							{pinnedIds.size > 1 ? String(pinnedIds.size) + " " : ""}{t("pinnedAll")}
						</button>
					) : null}
				</div>
			) : null}
			{hasMore ? (
				<div className="load-older">
					<button className="button ghost" disabled={loadingOlder} onClick={handleLoadOlder}>
						{loadingOlder ? <><LoadingIndicator size={18} /> {t("loadingOlder")}</> : t("loadEarlier")}
					</button>
				</div>
			) : null}
			{messages.length === 0 ? (
				<div className="thread-empty">
					<span className="thread-empty-art">
						<MorphBlob size={160} shapes={isSelf ? [7, 1, 4] : [6, 2, 1, 4]} />
					</span>
					<p>{isSelf ? t("savedEmpty") : t("noMessages")}</p>
				</div>
			) : null}
			{contextMenu ? (
				<Menu
					anchor={null}
					point={{ x: contextMenu.x, y: contextMenu.y }}
					header={contextReactions(contextMenu.message)}
					items={contextItems(contextMenu.message)}
					onClose={() => setContextMenu(null)}
				/>
			) : null}
			{(menuId || pickerId) ? createPortal(<div className="msg-overlay" onClick={() => { setMenuId(null); setPickerId(null) }} />, document.body) : null}
			{dayGroups.map((group) => (
			<div className="day-group" key={group.key}>
				<div className="day-divider"><span>{group.label}</span></div>
				{group.items.map((message) => {
				const mine = message.senderId === currentUserId
const sender = members.find((m) => m.userId === message.senderId)
const senderName = sender ? (sender.displayName || sender.username) : t("unknownUser")
const senderAvatar = sender ? sender.avatar : null
				const rowClass = "message-row" + (mine ? " mine" : "") + (flashId === message.id ? " flash" : "") + (isFreshArrival(message.id, message.createdAt) ? " msg-enter" : "")
				const bubbleClass =
					"bubble" +
					(mine ? " mine" : "") +
					(message.locked ? " locked" : "") +
					(message.deleted ? " deleted" : "")
				const parent = message.replyTo ? byId.get(message.replyTo) : undefined
				const grouped = groupReactions(byMessage.get(message.id) ?? [], currentUserId)
				const isPinned = pinnedIds.has(message.id)
				const poll = message.poll ? pollsByMessage.get(message.id) ?? null : null
				const mayClosePoll = message.senderId === currentUserId || canClosePoll
				return (
					<div key={message.id} data-message-id={message.id} className={rowClass + (leaving.has(message.id) ? " msg-leaving" : "")} ref={(el) => void (el ? rowRefs.current.set(message.id, el) : rowRefs.current.delete(message.id))}>
{!mine ? (
	senderAvatar ? (
		<img className="msg-avatar" src={senderAvatar} alt={senderName} />
	) : (
		<div className="msg-avatar msg-avatar-fallback" style={{ backgroundColor: senderColor(message.senderId) }}>{senderInitials(senderName)}</div>
	)
) : null}
						<div className={bubbleClass}>
{!mine ? <div className="bubble-sender" style={{ color: senderColor(message.senderId) }}>{senderName}{sender?.isBot ? <span className="bot-badge"><IBot size={11} /> BOT</span> : null}</div> : null}
							{parent ? (
								<ReplyPreview parent={parent} onResolveMedia={onResolveMedia} onJump={() => jumpTo(parent.id)} />
							) : null}
							<div className="bubble-text">
								{message.poll && !message.deleted && !message.locked ? (
									poll ? (
										<PollCard poll={poll} envelope={message.poll} canClose={mayClosePoll} onVote={(optionIndexes) => onVotePoll(message.id, optionIndexes)} onClose={() => onClosePoll(message.id)} />
									) : (
										<div className="media-status">{t("pollUnavailable")}</div>
									)
								) : message.media && !message.deleted && !message.locked ? (
									<div>
										<MediaBlock media={message.media} onResolveMedia={onResolveMedia} onOpenViewer={onOpenViewer ? () => onOpenViewer(message.id) : undefined} />
										{message.media.caption ? <div className="bubble-caption">{renderRichText(message.media.caption, isKnownMention)}</div> : null}
									</div>
								) : message.location && !message.deleted && !message.locked ? (
									<LocationBubble location={message.location} />
								) : message.contact && !message.deleted && !message.locked ? (
									<ContactBubble contact={message.contact} onMessage={onMessageContact} />
								) : message.deleted ? (
									t("messageDeleted")
								) : message.locked ? (
									t("messageEncrypted")
								) : (
									<>
										{renderRichText(message.text ?? "", isKnownMention)}
										{message.link ? <LinkCard card={message.link} /> : null}
									</>
								)}
							</div>
							{message.buttons && sender?.isBot && onBotButton && !message.deleted && !message.locked ? (
								<BotButtons rows={message.buttons} onPress={(button) => onBotButton(message, button)} />
							) : null}
							<div className="bubble-meta">
								{isPinned ? <div className="pinned-marker">{t("pinned")}</div> : null}
								{message.silent ? <span className="silent-marker" title={t("silentShort")} aria-label={t("silentShort")}><IBellOff size={12} /></span> : null}
								<div>{formatTimeOfDay(lang, message.createdAt)}</div>
								{createElement(TickMark, { read: Boolean(readIds && readIds.has(message.id)) })}
								{message.editedAt && !message.deleted ? <div className="edited">{t("edited")}</div> : null}
							</div>
							{grouped.length > 0 ? (
								<div className="reactions">
									{grouped.map((entry) => (
										<button
											key={entry.emoji}
											className={"reaction" + (entry.mine ? " mine" : "")}
											onClick={() => onToggleReaction(message.id, entry.emoji, !entry.mine)}
										>
											{entry.emoji}
											<div className="reaction-count">{entry.count}</div>
										</button>
									))}
								</div>
							) : null}
						</div>
						{message.deleted ? null : (
							<div className="msg-actions">
								<button className="msg-act" title={t("addReaction")} aria-label={t("addReaction")} onClick={(event) => { const open = pickerId !== message.id; setPickerStyle(open ? popoverStyle(event.currentTarget, mine, 380, 328) : null); setPickerId(open ? message.id : null); setMenuId(null) }}><IconEmoji /></button>
								<button className="msg-act" title={t("reply")} aria-label={t("reply")} onClick={() => onReply(message)}><IconReply /></button>
								<button className="msg-act" title={t("forward")} aria-label={t("forward")} onClick={() => onForward(message)}><IconForward /></button>
								<button className="msg-act" title={t("more")} aria-label={t("more")} onClick={(event) => { const open = menuId !== message.id; setMenuStyle(open ? popoverStyle(event.currentTarget, mine, 210) : null); setMenuId(open ? message.id : null); setPickerId(null) }}><IconMore /></button>
								{menuId === message.id ? (createPortal(
									<div className="msg-menu" style={menuStyle ?? undefined}>
										{message.media && !message.locked ? <button className="msg-menu-item" onClick={() => { setMenuId(null); void downloadMedia(message) }}>{t("download")}</button> : null}
										{mine && !message.poll && !message.media ? <button className="msg-menu-item" onClick={() => { setMenuId(null); onEdit(message) }}>{t("edit")}</button> : null}
										{mine ? <button className="msg-menu-item" onClick={() => { setMenuId(null); onDelete(message) }}>{t("deleteAction")}</button> : null}
										{canModerate ? <button className="msg-menu-item" onClick={() => { setMenuId(null); onTogglePin(message.id, !isPinned) }}>{isPinned ? t("unpin") : t("pin")}</button> : null}
										{isChannel ? <button className="msg-menu-item" onClick={() => { setMenuId(null); onOpenComments(message) }}>{t("comments")}</button> : null}
									</div>
								, document.body)) : null}
								{pickerId === message.id ? (createPortal(
									<div className="msg-picker" style={pickerStyle ?? undefined}>
										<div className="msg-picker-quick">
											{frequentEmoji(8, REACTION_SET).map((emoji) => (
												<button key={emoji} className="reaction-pick" onClick={() => { setPickerId(null); noteEmojiUsed(emoji); onToggleReaction(message.id, emoji, !grouped.some((g) => g.emoji === emoji && g.mine)) }}>{emoji}</button>
											))}
										</div>
										<EmojiPanel full={false} onPickEmoji={(emoji) => { setPickerId(null); onToggleReaction(message.id, emoji, !grouped.some((g) => g.emoji === emoji && g.mine)) }} onClose={() => setPickerId(null)} />
									</div>
								, document.body)) : null}
							</div>
						)}
					</div>
				)
			})}
			</div>
			))}
			{queued.map((item) => (
				<div key={item.id} className="message-row mine msg-enter">
					<div className="bubble mine queued">
						<div className="bubble-text">{renderRichText(item.body, isKnownMention)}</div>
						<div className="bubble-meta">
							<span className="queued-mark" aria-hidden="true">
								<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
									<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" />
								</svg>
							</span>
							<div>{t("queuedToSend")}</div>
						</div>
					</div>
				</div>
			))}
			{pending.map((item) => (
				<div key={item.id} className="message-row mine msg-enter">
					<div className="bubble mine">
						<div className="bubble-text">
							<div className="upload-card">
								{item.poster ? <img className="upload-poster" src={item.poster} alt="" /> : null}
								<div className="upload-main">
									<div className="upload-name">{item.name}</div>
									<div className="upload-stage">
										{item.stage === "encrypt" ? t("encrypting") : t("uploading")} {Math.round(item.progress * 100)}% · {formatBytes(item.size)}
									</div>
									<WavyProgress className="upload-wavy" value={item.progress > 0 ? item.progress : null} label={item.stage === "encrypt" ? t("encrypting") : t("uploading")} />
								</div>
							</div>
						</div>
					</div>
				</div>
			))}
			{hasNewer && onLoadNewer ? (
				<div className="load-older load-newer">
					<button className="button ghost" disabled={loadingNewer} onClick={onLoadNewer}>
						{loadingNewer ? <><LoadingIndicator size={18} /> {t("loadingOlder")}</> : t("loadNewer")}
					</button>
				</div>
			) : null}
			{typingLabel ? <div className="typing"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{typingLabel}</div> : null}
			<div ref={endRef} />
		</div>
	)
}