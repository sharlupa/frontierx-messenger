import { useEffect, useState } from "react"
import type { MediaEnvelope } from "../lib/media"
import { isVideoMedia } from "../lib/media"
import { useSettings } from "../state/settings"
import { formatDuration } from "../lib/voice"
import type { ViewerItem } from "./MediaViewer"
import { LoadingIndicator } from "./Expressive"
import { Sheet } from "./m3"
import { IGallery, IEyeOff } from "./m3icons"

// One tile of the grid. Images are decrypted on demand; a video shows the still
// frame that travelled with the message, so nothing is downloaded to browse.
function Tile({
	item,
	onResolveMedia,
	onOpen,
}: {
	item: ViewerItem
	onResolveMedia: (media: MediaEnvelope) => Promise<string | null>
	onOpen: () => void
}) {
	const [url, setUrl] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)
	const [revealed, setRevealed] = useState(!item.media.spoiler)
	const video = isVideoMedia(item.media)
	useEffect(() => {
		if (video) return
		let active = true
		void onResolveMedia(item.media)
			.then((resolved) => { if (active) setUrl(resolved) })
			.catch(() => { if (active) setFailed(true) })
		return () => { active = false }
	}, [item.media.fileId, video])
	const poster = video ? item.media.poster ?? null : url
	return (
		<button type="button" className={"gallery-tile" + (revealed ? "" : " spoiler")} onClick={() => (revealed ? onOpen() : setRevealed(true))} title={item.media.name}>
			{poster ? <img src={poster} alt="" loading="lazy" /> : <span className={"gallery-blank" + (failed ? " failed" : "")} aria-hidden="true" />}
			{!revealed ? <span className="gallery-spoiler" aria-hidden="true"><span className="media-spoiler-noise" /><IEyeOff size={18} /></span> : null}
			{video ? (
				<span className="gallery-video-mark" aria-hidden="true">
					<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.6a1 1 0 0 1 1.52-.86l9 6.4a1 1 0 0 1 0 1.72l-9 6.4A1 1 0 0 1 8 18.4z" /></svg>
					{item.media.duration && item.media.duration > 0 ? <em>{formatDuration(item.media.duration)}</em> : null}
				</span>
			) : null}
		</button>
	)
}

export function GalleryDialog({
	items,
	onClose,
	onOpen,
	onResolveMedia,
	hasMore,
	loadingOlder,
	onLoadOlder,
}: {
	items: ViewerItem[]
	onClose: () => void
	onOpen: (index: number) => void
	onResolveMedia: (media: MediaEnvelope) => Promise<string | null>
	hasMore: boolean
	loadingOlder: boolean
	onLoadOlder: () => void
}) {
	const { t } = useSettings()
	return (
		<Sheet title={t("galleryTitle")} icon={<IGallery />} iconShape="cookie" iconTone="pink" onClose={onClose} size="lg" className="gallery-sheet">
			{items.length === 0 ? (
				<div className="fp-empty">{t("galleryEmpty")}</div>
			) : (
				<div className="gallery-grid">
					{items.map((item, index) => (
						<Tile key={item.media.fileId} item={item} onResolveMedia={onResolveMedia} onOpen={() => onOpen(index)} />
					))}
				</div>
			)}
			{hasMore ? (
				<div className="gallery-more">
					<button className="button ghost" disabled={loadingOlder} onClick={onLoadOlder}>
						{loadingOlder ? <><LoadingIndicator size={18} /> {t("loadingOlder")}</> : t("loadEarlier")}
					</button>
				</div>
			) : null}
		</Sheet>
	)
}
