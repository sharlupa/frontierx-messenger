import { useEffect, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { EMOJI_GROUPS } from "../lib/reactions"
import { api } from "../lib/api"
import { gifToVideo } from "../lib/gif"
import { AvatarCropper } from "./AvatarCropper"
import type { Sticker } from "../lib/types"
import { useSettings } from "../state/settings"

const EMOJI_FREQ_KEY = "fx.emoji.freq"
const EMOJI_FREQ_LIMIT = 24

type EmojiFreq = Record<string, number>

function readEmojiFreq(): EmojiFreq {
	try {
		const raw = localStorage.getItem(EMOJI_FREQ_KEY)
		if (!raw) return {}
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== "object") return {}
		const out: EmojiFreq = {}
		for (const entry of Object.entries(parsed as Record<string, unknown>)) {
			const count = entry[1]
			if (typeof count === "number" && isFinite(count) && count > 0) out[entry[0]] = count
		}
		return out
	} catch {
		return {}
	}
}

// Counts are halved rather than dropped when the map grows, so long-standing
// favourites stay near the top while a new habit can still climb the list.
function noteEmojiUsed(emoji: string): EmojiFreq {
	const freq = readEmojiFreq()
	freq[emoji] = (freq[emoji] ?? 0) + 1
	let entries = Object.entries(freq).sort((a, b) => b[1] - a[1])
	if (entries.length > EMOJI_FREQ_LIMIT * 3) {
		entries = entries.slice(0, EMOJI_FREQ_LIMIT * 2).map((entry) => [entry[0], Math.max(1, Math.round(entry[1] / 2))] as [string, number])
	}
	const next: EmojiFreq = {}
	for (const entry of entries) next[entry[0]] = entry[1]
	try {
		localStorage.setItem(EMOJI_FREQ_KEY, JSON.stringify(next))
	} catch {}
	return next
}

function topEmoji(freq: EmojiFreq): string[] {
	return Object.entries(freq)
		.sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
		.slice(0, EMOJI_FREQ_LIMIT)
		.map((entry) => entry[0])
}

type Tab = "emoji" | "stickers" | "gifs"

export function EmojiPanel({
	onPickEmoji,
	onPickSticker,
	onSendGif,
	onClose,
	full = true,
}: {
	onPickEmoji: (emoji: string) => void
	onPickSticker?: (sticker: Sticker) => void
	onSendGif?: (url: string) => void
	onClose: () => void
	full?: boolean
}) {
	const { t } = useSettings()
	const [tab, setTab] = useState<Tab>("emoji")

	const [emojiFreq, setEmojiFreq] = useState<EmojiFreq>(() => readEmojiFreq())
	const frequent = topEmoji(emojiFreq)

	function pickEmoji(emoji: string): void {
		setEmojiFreq(noteEmojiUsed(emoji))
		onPickEmoji(emoji)
	}
	const [stickers, setStickers] = useState<Sticker[]>([])
	const [gifBusy, setGifBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [stickerDraft, setStickerDraft] = useState<string | null>(null)
	const stickerFileRef = useRef<HTMLInputElement | null>(null)
	const gifFileRef = useRef<HTMLInputElement | null>(null)

	useEffect(() => {
		if (!full || tab !== "stickers") return
		let active = true
		void api
			.listStickers()
			.then((res) => {
				if (active) setStickers(res.stickers)
			})
			.catch(() => {})
		return () => {
			active = false
		}
	}, [tab, full])

	function pickStickerFile(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files && event.target.files[0] ? event.target.files[0] : null
		event.target.value = ""
		if (!file) return
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result !== "string") return
			setStickerDraft(reader.result)
		}
		reader.readAsDataURL(file)
	}

	function saveSticker(dataUrl: string) {
		setStickerDraft(null)
		void api
			.createSticker(dataUrl)
			.then((res) => setStickers((items) => [res.sticker, ...items]))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}

	async function pickGifFile(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files && event.target.files[0] ? event.target.files[0] : null
		event.target.value = ""
		if (!file || !onSendGif) return
		setGifBusy(true)
		setError(null)
		try {
			const converted = await gifToVideo(file)
			onSendGif(converted.url)
			onClose()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setGifBusy(false)
		}
	}

	return (
		<div className="emoji-panel" role="dialog" aria-label={t("emojiTab")}>
			{full ? (
				<div className="emoji-tabs">
					<button type="button" className={"emoji-tab" + (tab === "emoji" ? " active" : "")} onClick={() => setTab("emoji")}>{t("emojiTab")}</button>
					<button type="button" className={"emoji-tab" + (tab === "stickers" ? " active" : "")} onClick={() => setTab("stickers")}>{t("stickersTab")}</button>
					<button type="button" className={"emoji-tab" + (tab === "gifs" ? " active" : "")} onClick={() => setTab("gifs")}>{t("gifsTab")}</button>
				</div>
			) : null}
			{error ? <div className="emoji-error">{error}</div> : null}
			{!full || tab === "emoji" ? (
				<div className="emoji-tab-body emoji-grid">
					{frequent.length > 0 ? (
						<div className="emoji-group">
							<div className="emoji-group-icon">{t("frequentEmoji")}</div>
							<div className="emoji-group-items">
								{frequent.map((emoji, fi) => (
									<button type="button" key={"freq" + emoji + fi} className="emoji-cell" onClick={() => pickEmoji(emoji)}>{emoji}</button>
								))}
							</div>
						</div>
					) : null}
					{EMOJI_GROUPS.map((group, gi) => (
						<div className="emoji-group" key={gi}>
							<div className="emoji-group-icon" aria-hidden="true">{group.icon}</div>
							<div className="emoji-group-items">
								{group.emoji.map((emoji, ei) => (
									<button type="button" key={emoji + ei} className="emoji-cell" onClick={() => pickEmoji(emoji)}>{emoji}</button>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
			{full && tab === "stickers" ? (
				<div className="emoji-tab-body">
					<div className="sticker-actions">
						<button type="button" className="button ghost small" onClick={() => stickerFileRef.current?.click()}>{t("createSticker")}</button>
						<input ref={stickerFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={pickStickerFile} />
					</div>
					{stickers.length === 0 ? (
						<div className="emoji-empty">{t("noStickers")}</div>
					) : (
						<div className="sticker-grid">
							{stickers.map((sticker) => (
								<button type="button" key={sticker.id} className="sticker-cell" onClick={() => onPickSticker && onPickSticker(sticker)}>
									<img src={sticker.data} alt="" />
								</button>
							))}
						</div>
					)}
				</div>
			) : null}
			{full && tab === "gifs" ? (
				<div className="emoji-tab-body">
					<div className="gif-upload">
						<button type="button" className="button small" disabled={gifBusy} onClick={() => gifFileRef.current?.click()}>{gifBusy ? t("convertingGif") : t("uploadGif")}</button>
						<input ref={gifFileRef} type="file" accept="image/gif,image/*,video/*" style={{ display: "none" }} onChange={pickGifFile} />
						<div className="gif-upload-hint">{t("gifUploadHint")}</div>
					</div>
				</div>
			) : null}
			{stickerDraft ? (
				<AvatarCropper src={stickerDraft} shape="rounded" outputSize={320} title={t("cropSticker")} onCancel={() => setStickerDraft(null)} onConfirm={saveSticker} />
			) : null}
			<div className="emoji-panel-foot">
				<button type="button" className="button ghost small" onClick={onClose}>{t("close")}</button>
			</div>
		</div>
	)
}