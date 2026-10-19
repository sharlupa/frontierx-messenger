import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useSettings } from "../state/settings"
import { useReducedMotion } from "./Expressive"
import { IconButton } from "./m3"
import { IClose, IDownload } from "./m3icons"

// A profile picture at full size. It grows out of the avatar that was pressed
// (from that spot and that shape) and shrinks back into it on close.
export function AvatarLightbox(props: { src: string; name: string; from?: DOMRect | null; round?: boolean; onClose: () => void }) {
	const { t } = useSettings()
	const reduced = useReducedMotion()
	const imgRef = useRef<HTMLImageElement>(null)
	const [phase, setPhase] = useState<"enter" | "open" | "leave">(reduced ? "open" : "enter")
	const [origin, setOrigin] = useState<CSSProperties | null>(null)
	const { onClose } = props

	// The transform that puts the full image exactly over the pressed avatar.
	const measure = () => {
		const img = imgRef.current
		const from = props.from
		if (!img || !from || from.width === 0) return null
		const box = img.getBoundingClientRect()
		if (box.width === 0 || box.height === 0) return null
		const scale = Math.max(from.width / box.width, from.height / box.height)
		const dx = from.left + from.width / 2 - (box.left + box.width / 2)
		const dy = from.top + from.height / 2 - (box.top + box.height / 2)
		return { transform: "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")", borderRadius: props.round === false ? "28%" : "50%" } as CSSProperties
	}

	const close = () => {
		if (phase === "leave") return
		if (reduced) {
			onClose()
			return
		}
		setOrigin(measure())
		setPhase("leave")
		window.setTimeout(onClose, 260)
	}
	const closeRef = useRef(close)
	closeRef.current = close

	useLayoutEffect(() => {
		if (phase !== "enter") return
		const img = imgRef.current
		if (!img) return
		const start = () => {
			setOrigin(measure())
			// Two frames: the start position must be painted before the move.
			requestAnimationFrame(() => requestAnimationFrame(() => setPhase("open")))
		}
		if (img.complete && img.naturalWidth > 0) start()
		else img.addEventListener("load", start, { once: true })
	}, [])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault()
				event.stopPropagation()
				closeRef.current()
			}
		}
		window.addEventListener("keydown", onKey, true)
		return () => window.removeEventListener("keydown", onKey, true)
	}, [])

	const download = () => {
		const link = document.createElement("a")
		link.href = props.src
		const ext = /^data:image\/(\w+)/.exec(props.src)?.[1] ?? "jpg"
		link.download = (props.name || "avatar").replace(/[\\/:*?"<>|]+/g, "_") + "." + (ext === "jpeg" ? "jpg" : ext)
		document.body.appendChild(link)
		link.click()
		link.remove()
	}

	const imgStyle: CSSProperties | undefined = phase === "open" ? undefined : origin ?? { opacity: 0, transform: "scale(0.92)" }
	return createPortal(
		<div className={"avatar-lightbox phase-" + phase} role="dialog" aria-modal="true" aria-label={props.name} onClick={close}>
			<div className="avatar-lightbox-bar" onClick={(event) => event.stopPropagation()}>
				<span className="avatar-lightbox-name">{props.name}</span>
				<IconButton label={t("download")} onClick={download}>
					<IDownload />
				</IconButton>
				<IconButton label={t("close")} onClick={close} variant="tonal">
					<IClose />
				</IconButton>
			</div>
			<img ref={imgRef} className="avatar-lightbox-img" src={props.src} alt={props.name} style={imgStyle} onClick={(event) => event.stopPropagation()} />
		</div>,
		document.body,
	)
}
