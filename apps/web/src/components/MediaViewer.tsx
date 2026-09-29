import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { MediaEnvelope } from "../lib/media"
import { isVideoMedia } from "../lib/media"
import { formatDateTime, timeFields } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { IconClose } from "./Icons"
import { LoadingIndicator, WavyProgress } from "./Expressive"

export type ViewerItem = { messageId: string; media: MediaEnvelope; author: string; createdAt: string }

const ZOOM_STEPS = [1, 2, 3]

export function MediaViewer({
	items,
	index,
	onIndexChange,
	onClose,
	onResolveMedia,
}: {
	items: ViewerItem[]
	index: number
	onIndexChange: (index: number) => void
	onClose: () => void
	onResolveMedia: (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>
}) {
	const { t, lang } = useSettings()
	const [url, setUrl] = useState<string | null>(null)
	const [failed, setFailed] = useState(false)
	const [progress, setProgress] = useState(0)
	const [zoom, setZoom] = useState(1)
	const [offset, setOffset] = useState({ x: 0, y: 0 })
	const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
	const touchRef = useRef<{ x: number; y: number } | null>(null)
	const current = items[index] ?? null
	const isVideo = current ? isVideoMedia(current.media) : false

	const step = useCallback((delta: number) => {
		if (items.length < 2) return
		const next = (index + delta + items.length) % items.length
		onIndexChange(next)
	}, [index, items.length, onIndexChange])

	useEffect(() => {
		setUrl(null)
		setFailed(false)
		setProgress(0)
		setZoom(1)
		setOffset({ x: 0, y: 0 })
		if (!current) return
		let active = true
		void onResolveMedia(current.media, (ratio) => { if (active) setProgress(ratio) })
			.then((resolved) => { if (!active) return; if (resolved) setUrl(resolved); else setFailed(true) })
			.catch(() => { if (active) setFailed(true) })
		return () => { active = false }
	}, [current ? current.media.fileId : "", onResolveMedia])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); onClose() }
			else if (event.key === "ArrowRight") { event.preventDefault(); step(1) }
			else if (event.key === "ArrowLeft") { event.preventDefault(); step(-1) }
		}
		window.addEventListener("keydown", onKey)
		// The page behind must not scroll while the viewer is open.
		const previous = document.body.style.overflow
		document.body.style.overflow = "hidden"
		return () => {
			window.removeEventListener("keydown", onKey)
			document.body.style.overflow = previous
		}
	}, [onClose, step])

	if (!current) return null

	function cycleZoom() {
		const position = ZOOM_STEPS.indexOf(zoom)
		const next = ZOOM_STEPS[(position + 1) % ZOOM_STEPS.length]
		setZoom(next)
		if (next === 1) setOffset({ x: 0, y: 0 })
	}

	function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
		if (zoom === 1) return
		dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
		const drag = dragRef.current
		if (!drag) return
		setOffset({ x: drag.ox + (event.clientX - drag.x), y: drag.oy + (event.clientY - drag.y) })
	}

	function onPointerUp() {
		dragRef.current = null
	}

	function onTouchStart(event: React.TouchEvent<HTMLDivElement>) {
		if (zoom !== 1 || event.touches.length !== 1) return
		touchRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
	}

	function onTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
		const start = touchRef.current
		touchRef.current = null
		if (!start || zoom !== 1) return
		const touch = event.changedTouches[0]
		if (!touch) return
		const dx = touch.clientX - start.x
		const dy = touch.clientY - start.y
		if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return
		step(dx < 0 ? 1 : -1)
	}

	function download() {
		if (!url) return
		const link = document.createElement("a")
		link.href = url
		link.download = current!.media.name || "file"
		document.body.appendChild(link)
		link.click()
		link.remove()
	}

	const stamp = (() => {
		return formatDateTime(lang, current.createdAt, { day: "numeric", month: "short", ...timeFields(lang) })
	})()

	return createPortal(
		<div className="viewer" role="dialog" aria-modal="true" onClick={onClose}>
			<div className="viewer-bar" onClick={(event) => event.stopPropagation()}>
				<div className="viewer-meta">
					<span className="viewer-author">{current.author}</span>
					<span className="viewer-stamp">{stamp}</span>
				</div>
				<div className="viewer-actions">
					{items.length > 1 ? <span className="viewer-count">{index + 1} / {items.length}</span> : null}
					<button type="button" className="viewer-btn" onClick={download} disabled={!url} title={t("download")} aria-label={t("download")}>
						<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="M12 4v11" /><path d="M8 11l4 4 4-4" /><path d="M5 19h14" />
						</svg>
					</button>
					<button type="button" className="viewer-btn" onClick={onClose} title={t("close")} aria-label={t("close")}><IconClose size={18} /></button>
				</div>
			</div>

			<div
				className="viewer-stage"
				onClick={(event) => event.stopPropagation()}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onTouchStart={onTouchStart}
				onTouchEnd={onTouchEnd}
			>
				{failed ? (
					<div className="viewer-status">{t("imageUnavailable")}</div>
				) : !url ? (
					<div className="viewer-status viewer-loading">
						{progress > 0 ? <WavyProgress value={progress} label={t("loadingImage")} /> : <LoadingIndicator size={56} contained label={t("loadingImage")} />}
						<span>{progress > 0 ? Math.round(progress * 100) + "%" : t("loadingImage")}</span>
					</div>
				) : isVideo ? (
					<video className="viewer-video" src={url} controls autoPlay playsInline />
				) : (
					<img
						className={"viewer-image" + (zoom > 1 ? " zoomed" : "")}
						src={url}
						alt={current.media.name}
						style={{ transform: "translate(" + offset.x + "px, " + offset.y + "px) scale(" + zoom + ")" }}
						onClick={cycleZoom}
						draggable={false}
					/>
				)}
			</div>

			{items.length > 1 ? (
				<>
					<button type="button" className="viewer-nav prev" onClick={(event) => { event.stopPropagation(); step(-1) }} aria-label={t("previous")}>
						<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
					</button>
					<button type="button" className="viewer-nav next" onClick={(event) => { event.stopPropagation(); step(1) }} aria-label={t("next")}>
						<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
					</button>
				</>
			) : null}

			{current.media.caption ? <div className="viewer-caption" onClick={(event) => event.stopPropagation()}>{current.media.caption}</div> : null}
		</div>,
		document.body,
	)
}
