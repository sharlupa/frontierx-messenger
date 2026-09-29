import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useSettings } from "../state/settings"
import { Button, Sheet } from "./m3"
import { IImage } from "./m3icons"

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	const radius = Math.min(r, w / 2, h / 2)
	ctx.moveTo(x + radius, y)
	ctx.lineTo(x + w - radius, y)
	ctx.arcTo(x + w, y, x + w, y + radius, radius)
	ctx.lineTo(x + w, y + h - radius)
	ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
	ctx.lineTo(x + radius, y + h)
	ctx.arcTo(x, y + h, x, y + h - radius, radius)
	ctx.lineTo(x, y + radius)
	ctx.arcTo(x, y, x + radius, y, radius)
}

export function AvatarCropper({
	src,
	onCancel,
	onConfirm,
	shape = "circle",
	outputSize = 256,
	title,
}: {
	src: string
	onCancel: () => void
	onConfirm: (dataUrl: string) => void
	shape?: "circle" | "rounded"
	outputSize?: number
	title?: string
}) {
	const { t } = useSettings()
	const [img, setImg] = useState<HTMLImageElement | null>(null)
	const [zoom, setZoom] = useState(1)
	const [offset, setOffset] = useState({ x: 0, y: 0 })
	const [frame, setFrame] = useState(260)
	const dragRef = useRef<{ x: number; y: number } | null>(null)
	const frameElRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		const image = new Image()
		image.onload = () => setImg(image)
		image.src = src
	}, [src])

	useLayoutEffect(() => {
		const el = frameElRef.current
		if (!el) return
		const measure = () => {
			const size = Math.round(el.getBoundingClientRect().width)
			if (size > 0) setFrame(size)
		}
		measure()
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	const baseScale = img ? Math.max(frame / img.width, frame / img.height) : 1
	const scale = baseScale * zoom
	const drawW = img ? img.width * scale : 0
	const drawH = img ? img.height * scale : 0
	const originX = (frame - drawW) / 2 + offset.x
	const originY = (frame - drawH) / 2 + offset.y

	function clamp(x: number, y: number): { x: number; y: number } {
		const maxX = Math.max(0, (drawW - frame) / 2)
		const maxY = Math.max(0, (drawH - frame) / 2)
		return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
	}

	useEffect(() => {
		setOffset((current) => clamp(current.x, current.y))
	}, [zoom, img, frame])

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
		dragRef.current = { x: event.clientX - offset.x, y: event.clientY - offset.y }
		event.currentTarget.setPointerCapture(event.pointerId)
	}
	function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
		if (!dragRef.current) return
		setOffset(clamp(event.clientX - dragRef.current.x, event.clientY - dragRef.current.y))
	}
	function endDrag() {
		dragRef.current = null
	}

	function confirm() {
		if (!img) return
		const canvas = document.createElement("canvas")
		canvas.width = outputSize
		canvas.height = outputSize
		const context = canvas.getContext("2d")
		if (!context) return
		const sx = -originX / scale
		const sy = -originY / scale
		const sSize = frame / scale
		context.imageSmoothingQuality = "high"
		if (shape === "rounded") {
			context.beginPath()
			roundRectPath(context, 0, 0, outputSize, outputSize, outputSize * 0.18)
			context.closePath()
			context.clip()
		}
		context.drawImage(img, sx, sy, sSize, sSize, 0, 0, outputSize, outputSize)
		if (shape === "rounded") {
			onConfirm(canvas.toDataURL("image/png"))
		} else {
			onConfirm(canvas.toDataURL("image/jpeg", 0.9))
		}
	}

	return (
		<Sheet title={title || t("adjustPhoto")} icon={<IImage />} iconShape="cookie" iconTone="pink" onClose={onCancel} size="sm" className="cropper-sheet"
			actions={
				<>
					<Button variant="text" onClick={onCancel}>{t("cancel")}</Button>
					<Button variant="filled" onClick={confirm} disabled={!img}>{t("saveChanges")}</Button>
				</>
			}
		>
			<div className="cropper-stage">
				<div
					className="cropper-frame"
					ref={frameElRef}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerLeave={endDrag}
				>
					{img ? (
						<img
							className="cropper-image"
							src={src}
							alt=""
							draggable={false}
							style={{ width: drawW + "px", height: drawH + "px", left: originX + "px", top: originY + "px" }}
						/>
					) : null}
					<div className={"cropper-ring" + (shape === "rounded" ? " rounded" : "")} aria-hidden="true" />
				</div>
			</div>
			<input className="cropper-zoom" type="range" min={1} max={3} step={0.01} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label={t("zoom")} />
		</Sheet>
	)
}
