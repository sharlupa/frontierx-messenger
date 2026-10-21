import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react"
import type { DisplayMessage, Reaction, PollSummary, ConversationMember } from "../lib/types"
import { REACTION_SET } from "../lib/reactions"
import { isAnimatedMedia, isAudioMedia, isVideoMedia, type MediaEnvelope } from "../lib/media"
import { formatBytes as formatSize, formatDate, formatTimeOfDay, getActiveLang, type Lang, type StringKey } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { BotBadge } from "./BotBadge"
import { PollCard } from "./PollCard"
import { EmojiPanel, frequentEmoji, noteEmojiUsed } from "./EmojiPanel"
import { IconEmoji, IconReply, IconForward, IconMore, IconFile } from "./Icons"
import { formatDuration, WAVEFORM_BARS } from "../lib/voice"
import { safePreview } from "../lib/imagethumb"
import { albumOf, albumRows, groupAlbums, type ThreadUnit } from "../lib/album"
import { renderRichText, stripFormatting } from "../lib/richtext"
import { LoadingBlock, LoadingIndicator, MorphBlob, WavyCircle, WavyProgress } from "./Expressive"
import type { PendingUpload } from "../routes/Chat"
import { ContactBubble, LocationBubble } from "./RichBubbles"
import { IArrowDown, IBellOff, IChat, ICopy, IDownload, IEdit, IEyeOff, IForward, ILink, IPin, IPinOff, IPlay, IReply, ISmilePlus, ITrash } from "./m3icons"
import { IconButton, Menu, type MenuItemSpec } from "./m3"
import { useContextMenuGesture } from "../lib/longpress"
import { isOffline, onOfflineChange } from "../lib/offline"
import type { BotButton } from "../lib/botmsg"

// How long the thread holds on to its end after a send, while the message
// (or the latest page of history) is on its way.
const SENT_HOLD_MS = 1500
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

export function formatBytes(size: number): string {
	return size > 0 ? formatSize(getActiveLang(), size) : ""
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

// The reaction picker is as wide as the emoji panel, or the whole screen
// minus a margin on a phone, so it sits centred there instead of hanging off
// the message.
const REACTION_PICKER_WIDTH = 360
const REACTION_PICKER_HEIGHT = 420
const PICKER_SCREEN_MARGIN = 8
// Same breakpoint as the phone layout in m3-emoji.css.
const PHONE_QUERY = "(max-width: 520px)"
function reactionPickerStyle(anchor: HTMLElement, mine: boolean): CSSProperties {
  const screenWidth = window.innerWidth - PICKER_SCREEN_MARGIN * 2
  const width = window.matchMedia(PHONE_QUERY).matches ? screenWidth : Math.min(REACTION_PICKER_WIDTH, screenWidth)
  return { ...popoverStyle(anchor, mine, REACTION_PICKER_HEIGHT, width), width }
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
// Why a file did not open: no network and no copy on this device, or
// anything else. The first clears once the server answers again.
type MediaFailure = "offline" | "error" | null

function useClearWhenOnline(failure: MediaFailure, clear: () => void): void {
	useEffect(() => {
		if (failure !== "offline") return
		return onOfflineChange((offline) => {
			if (!offline) clear()
		})
	}, [failure])
}

function VideoBlock(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onExpand?: () => void }) {
	const { t } = useSettings()
	const [url, setUrl] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [progress, setProgress] = useState(0)
	const [failed, setFailed] = useState<MediaFailure>(null)
	useClearWhenOnline(failed, () => setFailed(null))
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
			else setFailed("error")
		} catch {
			setFailed(isOffline() ? "offline" : "error")
		} finally {
			setLoading(false)
		}
	}

	if (failed) return <div className="media-status">{failed === "offline" ? t("mediaNotSaved") : t("videoUnavailable")}</div>

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
				{safePreview(props.media.poster) ? <img className="video-poster-img" src={safePreview(props.media.poster) ?? undefined} alt="" /> : <span className="video-poster-blank" aria-hidden="true" />}
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
			{safePreview(props.poster) ? <img className="media-spoiler-poster" src={safePreview(props.poster) ?? undefined} alt="" /> : null}
			<span className="media-spoiler-noise" aria-hidden="true" />
			<span className="media-spoiler-label"><IEyeOff size={16} /> {t("spoilerLabel")}</span>
		</button>
	)
}

// Photos and videos sent together, as one grid: wide rows for a few, three a
// row for many (lib/album.ts). Each tile opens the viewer at its own picture;
// a spoiler tile is revealed on its own.
// While an album uploads, the photos still on their way take their places in
// the same grid (pending), so it never assembles itself tile by tile.
function AlbumGrid(props: { members: DisplayMessage[]; pending?: PendingUpload[]; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onOpenViewer?: (messageId: string) => void }) {
	type Slot = { key: string; index: number; message?: DisplayMessage; upload?: PendingUpload }
	const slots: Slot[] = props.members
		.map((message, at): Slot => ({ key: message.id, index: albumOf(message.media)?.index ?? at, message }))
		.concat((props.pending ?? []).map((upload, at): Slot => ({ key: upload.id, index: upload.album?.index ?? props.members.length + at, upload })))
		.sort((a, b) => a.index - b.index)
	const rows = albumRows(slots.length)
	let next = 0
	return (
		<div className="album-grid">
			{rows.map((size, row) => {
				const items = slots.slice(next, next + size)
				next += size
				return (
					<div key={row} className={"album-row n" + size}>
						{items.map((slot) => {
							if (slot.upload) return <PendingTile key={slot.key} item={slot.upload} />
							const message = slot.message
							return message?.media ? <AlbumTile key={slot.key} media={message.media} onResolveMedia={props.onResolveMedia} onOpen={props.onOpenViewer ? () => props.onOpenViewer?.(message.id) : undefined} /> : null
						})}
					</div>
				)
			})}
		</div>
	)
}

// A photo of an album still uploading: its own picture, dimmed, with how far
// it has got (a spinning ring while it waits for its turn).
function PendingTile(props: { item: PendingUpload }) {
	const { t } = useSettings()
	const queued = props.item.stage === "queued"
	const percent = Math.round(props.item.progress * 100)
	// Sent in full but not yet in the chat (waiting for the server, or for the
	// photos before it): a spinning ring rather than a ring stuck at 100.
	const spinning = queued || props.item.progress <= 0 || props.item.progress >= 1
	const label = queued ? t("uploadQueued") : props.item.stage === "encrypt" ? t("encrypting") : t("uploading")
	return (
		<div className="album-tile pending" role="img" aria-label={label + (queued ? "" : " " + String(percent) + "%") + ": " + props.item.name}>
			{props.item.poster ? <img className="album-img" src={props.item.poster} alt="" /> : <span className="album-skeleton" aria-hidden="true" />}
			<span className="album-progress" aria-hidden="true">
				<WavyCircle value={spinning ? null : props.item.progress} size={40} label={label}>{spinning ? null : percent}</WavyCircle>
			</span>
		</div>
	)
}

function AlbumTile(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onOpen?: () => void }) {
	const { t } = useSettings()
	const [revealed, setRevealed] = useState(!props.media.spoiler)
	const [url, setUrl] = useState<string | null>(null)
	const video = isVideoMedia(props.media)
	const poster = safePreview(props.media.poster)
	useEffect(() => {
		if (video || !revealed) return
		let active = true
		void props.onResolveMedia(props.media).then((resolved) => { if (active) setUrl(resolved) }).catch(() => undefined)
		return () => { active = false }
	}, [props.media.fileId, video, revealed])
	if (!revealed) {
		return (
			<div className="album-tile">
				<SpoilerCover onReveal={() => setRevealed(true)} poster={props.media.poster} />
			</div>
		)
	}
	const shown = video ? poster : url
	return (
		<button type="button" className="album-tile" onClick={props.onOpen} aria-label={(video ? t("playVideo") : t("openImage")) + ": " + props.media.name}>
			{shown ? <img className="album-img" src={shown} alt="" /> : poster ? <img className="album-img album-blur" src={poster} alt="" /> : null}
			{!shown && !video ? <span className="album-loader"><LoadingIndicator size={24} label={t("loadingImage")} /></span> : null}
			{video ? <span className="album-play" aria-hidden="true"><IPlay size={18} /></span> : null}
		</button>
	)
}

// The box a photo or video takes in a bubble, known before the file arrives
// when the message carries the size: as wide as the picture up to the bubble
// limit, in its own proportions.
const MEDIA_BOX_MAX_WIDTH = 280
function mediaBox(media: MediaEnvelope): CSSProperties {
	const width = media.width && media.height ? Math.min(MEDIA_BOX_MAX_WIDTH, media.width) : MEDIA_BOX_MAX_WIDTH
	const ratio = media.width && media.height ? media.width + " / " + media.height : "4 / 3"
	return { width: width + "px", aspectRatio: ratio }
}

function MediaBlock(props: { media: MediaEnvelope; onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>; onOpenViewer?: () => void }) {
	const [revealed, setRevealed] = useState(!props.media.spoiler)
	if (!revealed) {
		const isVisual = props.media.kind === "image" || isVideoMedia(props.media)
		if (isVisual) {
			return (
				<div className="media-image-wrap spoiler-wrap" style={mediaBox(props.media)}>
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
	const [failed, setFailed] = useState<MediaFailure>(null)
	const [attempt, setAttempt] = useState(0)
	useClearWhenOnline(failed, () => {
		setFailed(null)
		setAttempt((value) => value + 1)
	})
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
				if (active) setFailed(isOffline() ? "offline" : "error")
			}
		}
		void run()
		return () => {
			active = false
		}
	}, [props.media.fileId, isImage, isLoopingClip, attempt])
	const unavailable = failed === "offline" ? t("mediaNotSaved") : t("imageUnavailable")

	if (isVoice) {
		return <VoiceBlock media={props.media} onResolveMedia={props.onResolveMedia} />
	}
	if (isLoopingClip) {
		return (
			<div className="media-image-wrap">
				{failed ? (
					<div className="media-status">{unavailable}</div>
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
				{failed === "offline" && props.media.width && props.media.height ? (
					// Not on this device: the blurred preview keeps the photo's place.
					<div className="media-placeholder" style={mediaBox(props.media)}>
						{safePreview(props.media.poster) ? <img className="media-placeholder-img" src={safePreview(props.media.poster) ?? undefined} alt="" /> : null}
						<span className="media-offline-note">{unavailable}</span>
					</div>
				) : failed ? (
					<div className="media-status">{unavailable}</div>
				) : url ? (
					<img
						src={url}
						alt={props.media.name}
						// With the size known the bubble is exactly as wide as the photo.
						style={props.media.width && props.media.height ? { width: mediaBox(props.media).width } : undefined}
						className={"bubble-image" + (props.onOpenViewer ? " clickable" : "")}
						onClick={props.onOpenViewer}
						role={props.onOpenViewer ? "button" : undefined}
					/>
				) : props.media.width && props.media.height ? (
					// The photo's place is kept, with its blurred preview, while it loads.
					<div className="media-placeholder" style={mediaBox(props.media)}>
						{safePreview(props.media.poster) ? <img className="media-placeholder-img" src={safePreview(props.media.poster) ?? undefined} alt="" /> : null}
						<LoadingIndicator size={36} label={t("loadingImage")} />
					</div>
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

// One tick when sent, two when read: drawn large enough to tell apart at a
// glance, with a clear gap between the two.
function TickMark(props: { read: boolean }) {
	const marks: any[] = [createElement("polyline", { key: "a", points: "2 8.5 6 12.5 13.5 4.5" })]
	if (props.read) marks.push(createElement("polyline", { key: "b", points: "12.5 12.5 20 4.5" }))
	return createElement("span", { className: "read-ticks" + (props.read ? " read" : "") }, createElement("svg", { viewBox: "0 0 22 16", width: 19, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, marks))
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
	notSaved = false,
	readIds = null,
	conversationId = null,
	pending = [],
	queued = [],
	hasNewer = false,
	loadingNewer = false,
	onLoadNewer,
	onShowLatest,
	sentAt = 0,
	onMessageContact,
	onBotButton,
	onOpenProfile,
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
	// Read without a network, and the device has nothing of this chat yet.
	notSaved?: boolean
	conversationId?: string | null
	pending?: PendingUpload[]
	queued?: Array<{ id: string; body: string; createdAt: string }>
	hasNewer?: boolean
	loadingNewer?: boolean
	onLoadNewer?: () => void
	// Back from older history to the latest messages (replacing the window).
	onShowLatest?: () => void
	// When this device last sent something to the chat: the thread goes to its end.
	sentAt?: number
	onMessageContact?: (username: string) => void
	onBotButton?: (message: DisplayMessage, button: BotButton) => Promise<void>
	onOpenProfile?: (userId: string) => void
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
	// Read far enough up (half a screen above the end) and a button offers
	// the way back down.
	const [awayFromEnd, setAwayFromEnd] = useState(false)
	const handleScroll = useCallback(() => {
		const el = listRef.current
		if (!el) return
		const distance = el.scrollHeight - el.clientHeight - el.scrollTop
		atBottomRef.current = distance < 80
		setAwayFromEnd(distance > el.clientHeight / 2)
	}, [])
	const scrollDown = useCallback(() => {
		const el = listRef.current
		if (!el) return
		// Reading older history opened at a search hit: the latest messages are
		// not loaded yet, so they are fetched and the chat waits at the end.
		if (hasNewer && onShowLatest) {
			atBottomRef.current = true
			holdBottom(SENT_HOLD_MS)
			onShowLatest()
			return
		}
		dropStick()
		el.scrollTo({ top: el.scrollHeight, behavior: document.documentElement.dataset.motion === "reduced" ? "auto" : "smooth" })
	}, [dropStick, hasNewer, onShowLatest, holdBottom])
	// Sending from this device brings the chat to its end, wherever it was
	// read, and keeps it there while the message lands.
	useEffect(() => {
		if (!sentAt) return
		atBottomRef.current = true
		holdBottom(SENT_HOLD_MS)
	}, [sentAt, holdBottom])
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
		const groups: Array<{ key: string; label: string; items: DisplayMessage[]; units: ThreadUnit[] }> = []
		for (const message of messages) {
			const key = dayKey(message.createdAt)
			const last = groups.length > 0 ? groups[groups.length - 1] : null
			if (!last || last.key !== key) groups.push({ key, label: dayLabel(message.createdAt, lang, t), items: [message], units: [] })
			else last.items.push(message)
		}
		// Photos sent together are drawn as one album.
		for (const group of groups) group.units = groupAlbums(group.items)
		return groups
	}, [messages, lang, t])
	// The messages of an album, by the id of its first one: downloading or
	// deleting the album acts on all of them.
	const albumMembers = useMemo(() => {
		const map = new Map<string, DisplayMessage[]>()
		for (const group of dayGroups) for (const unit of group.units) if (unit.members.length > 1) map.set(unit.lead.id, unit.members)
		return map
	}, [dayGroups])
	const membersOf = (message: DisplayMessage): DisplayMessage[] => albumMembers.get(message.id) ?? [message]
	// Uploads of an album join its grid; an album none of whose photos has
	// arrived yet is drawn below as a grid of uploads only.
	const pendingByAlbum = useMemo(() => {
		const map = new Map<string, PendingUpload[]>()
		for (const item of pending ?? []) {
			if (!item.album) continue
			const list = map.get(item.album.id) ?? []
			list.push(item)
			map.set(item.album.id, list)
		}
		return map
	}, [pending])
	const shownAlbumIds = useMemo(() => {
		const ids = new Set<string>()
		for (const group of dayGroups) for (const unit of group.units) {
			const id = albumOf(unit.lead.media)?.id
			if (id) ids.add(id)
		}
		return ids
	}, [dayGroups])

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
			...(message.media && !message.locked ? [{ key: "download", label: t("download"), icon: <IDownload size={20} />, onSelect: () => { for (const item of membersOf(message)) void downloadMedia(item) } }] : []),
			...(isChannel ? [{ key: "comments", label: t("comments"), icon: <IChat size={20} />, onSelect: () => onOpenComments(message) }] : []),
			...(mine ? [{ key: "delete", label: t("deleteAction"), icon: <ITrash size={20} />, danger: true, onSelect: () => { for (const item of membersOf(message)) onDelete(item) } }] : []),
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
						setPickerStyle(reactionPickerStyle(bubble, message.senderId === currentUserId))
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
					<p>{notSaved ? t("chatNotSaved") : isSelf ? t("savedEmpty") : t("noMessages")}</p>
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
				{group.units.map(({ lead: message, members: albumItems }) => {
				const albumId = message.deleted || message.locked ? null : albumOf(message.media)?.id ?? null
				const albumUploads = albumId ? pendingByAlbum.get(albumId) : undefined
				const album = albumItems.length > 1 || albumUploads?.length ? albumItems : null
				const lastMember = albumItems[albumItems.length - 1]
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
					<div key={message.id} data-message-id={message.id} className={rowClass + (leaving.has(message.id) ? " msg-leaving" : "")} ref={(el) => { for (const item of albumItems) { if (el) rowRefs.current.set(item.id, el); else rowRefs.current.delete(item.id) } }}>
{!mine ? (
	onOpenProfile ? (
		<button
			type="button"
			className={"msg-avatar msg-avatar-btn" + (senderAvatar ? "" : " msg-avatar-fallback")}
			style={senderAvatar ? undefined : { backgroundColor: senderColor(message.senderId) }}
			onClick={(event) => { event.stopPropagation(); onOpenProfile(message.senderId) }}
			aria-label={t("openProfile") + ": " + senderName}
			title={senderName}
		>
			{senderAvatar ? <img src={senderAvatar} alt="" /> : senderInitials(senderName)}
		</button>
	) : senderAvatar ? (
		<img className="msg-avatar" src={senderAvatar} alt={senderName} />
	) : (
		<div className="msg-avatar msg-avatar-fallback" style={{ backgroundColor: senderColor(message.senderId) }}>{senderInitials(senderName)}</div>
	)
) : null}
						<div className={bubbleClass}>
{!mine ? (
	<div className="bubble-sender" style={{ color: senderColor(message.senderId) }}>
		{onOpenProfile ? <button type="button" className="bubble-sender-link" onClick={(event) => { event.stopPropagation(); onOpenProfile(message.senderId) }}>{senderName}</button> : senderName}
		{sender?.isBot ? <BotBadge /> : null}
	</div>
) : null}
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
										{album ? (
											<AlbumGrid members={album} pending={albumUploads} onResolveMedia={onResolveMedia} onOpenViewer={onOpenViewer} />
										) : (
											<MediaBlock media={message.media} onResolveMedia={onResolveMedia} onOpenViewer={onOpenViewer ? () => onOpenViewer(message.id) : undefined} />
										)}
										{(() => {
											const caption = albumItems.map((item) => item.media?.caption).find(Boolean)
											return caption ? <div className="bubble-caption">{renderRichText(caption, isKnownMention)}</div> : null
										})()}
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
								{createElement(TickMark, { read: Boolean(readIds && readIds.has(lastMember.id)) })}
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
								<button className="msg-act" title={t("addReaction")} aria-label={t("addReaction")} onClick={(event) => { const open = pickerId !== message.id; setPickerStyle(open ? reactionPickerStyle(event.currentTarget, mine) : null); setPickerId(open ? message.id : null); setMenuId(null) }}><IconEmoji /></button>
								<button className="msg-act" title={t("reply")} aria-label={t("reply")} onClick={() => onReply(message)}><IconReply /></button>
								<button className="msg-act" title={t("forward")} aria-label={t("forward")} onClick={() => onForward(message)}><IconForward /></button>
								<button className="msg-act" title={t("more")} aria-label={t("more")} onClick={(event) => { const open = menuId !== message.id; setMenuStyle(open ? popoverStyle(event.currentTarget, mine, 210) : null); setMenuId(open ? message.id : null); setPickerId(null) }}><IconMore /></button>
								{menuId === message.id ? (createPortal(
									<div className="msg-menu" style={menuStyle ?? undefined}>
										{message.media && !message.locked ? <button className="msg-menu-item" onClick={() => { setMenuId(null); for (const item of albumItems) void downloadMedia(item) }}>{t("download")}</button> : null}
										{mine && !message.poll && !message.media ? <button className="msg-menu-item" onClick={() => { setMenuId(null); onEdit(message) }}>{t("edit")}</button> : null}
										{mine ? <button className="msg-menu-item" onClick={() => { setMenuId(null); for (const item of albumItems) onDelete(item) }}>{t("deleteAction")}</button> : null}
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
			{[...pendingByAlbum.entries()].filter(([id]) => !shownAlbumIds.has(id)).map(([id, uploads]) => (
				<div key={"album-" + id} className="message-row mine msg-enter">
					<div className="bubble mine">
						<div className="bubble-text">
							<AlbumGrid members={[]} pending={uploads} onResolveMedia={onResolveMedia} />
							{(() => {
								const caption = uploads.map((item) => item.caption).find(Boolean)
								return caption ? <div className="bubble-caption">{renderRichText(caption, isKnownMention)}</div> : null
							})()}
						</div>
					</div>
				</div>
			))}
			{pending.filter((item) => !item.album).map((item) => (
				<div key={item.id} className="message-row mine msg-enter">
					<div className="bubble mine">
						<div className="bubble-text">
							<div className="upload-card">
								{item.poster ? <img className="upload-poster" src={item.poster} alt="" /> : null}
								<div className="upload-main">
									<div className="upload-name">{item.name}</div>
									<div className="upload-stage">
										{item.stage === "queued" ? t("uploadQueued") : (item.stage === "encrypt" ? t("encrypting") : t("uploading")) + " " + String(Math.round(item.progress * 100)) + "%"} · {formatBytes(item.size)}
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
			{awayFromEnd || (hasNewer && onShowLatest) ? (
				<div className="jump-down-dock">
					<IconButton className="jump-down" variant="tonal" label={t("scrollToLatest")} onClick={scrollDown}>
						<IArrowDown size={22} />
					</IconButton>
				</div>
			) : null}
		</div>
	)
}