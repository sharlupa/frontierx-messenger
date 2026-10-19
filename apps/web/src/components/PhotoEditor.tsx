import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useSettings } from "../state/settings"
import type { StringKey } from "../lib/i18n"
import { Button, Chip, IconButton } from "./m3"
import { IBrush, ICrop, IRefresh, IRotateLeft, IUndo } from "./m3icons"

// An optional step before a photo is sent: crop it, turn it, draw on it.
// Everything happens on this device; the result replaces the staged file.

type Rect = { x: number; y: number; w: number; h: number }
type Stroke = { color: string; width: number; points: Array<[number, number]> }
type Mode = "crop" | "draw"
type Drag =
	| { kind: "stroke" }
	| { kind: "move"; startX: number; startY: number; from: Rect }
	| { kind: "corner"; corner: 0 | 1 | 2 | 3; from: Rect }

// Photos bigger than this are scaled down while editing (and in the result).
const MAX_EDGE = 4096
// Room around the picture inside the stage, in CSS pixels.
const STAGE_PADDING = 20
// How close to a corner a finger has to be to grab it, in CSS pixels.
const HANDLE_REACH = 28
// The smallest crop, as a share of the shorter side.
const MIN_CROP_SHARE = 0.08
const ASPECTS: ReadonlyArray<{ label: StringKey | string; value: number | null }> = [
	{ label: "photoAspectFree", value: null },
	{ label: "1:1", value: 1 },
	{ label: "4:3", value: 4 / 3 },
	{ label: "3:4", value: 3 / 4 },
	{ label: "16:9", value: 16 / 9 },
]
const COLORS = ["#ffffff", "#111111", "#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ff2d92"]
// Brush widths as a share of the longer side.
const BRUSHES = [0.005, 0.01, 0.02]
const JPEG_QUALITY = 0.92

function canvasOf(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas")
	canvas.width = width
	canvas.height = height
	return canvas
}

// Turns the picture a quarter to the left; points keep their place on it.
function rotateLeft(source: HTMLCanvasElement): HTMLCanvasElement {
	const out = canvasOf(source.height, source.width)
	const context = out.getContext("2d")
	if (context) {
		context.translate(0, source.width)
		context.rotate(-Math.PI / 2)
		context.drawImage(source, 0, 0)
	}
	return out
}
const rotatePoint = (point: [number, number], width: number): [number, number] => [point[1], width - point[0]]
const rotateRect = (rect: Rect, width: number): Rect => ({ x: rect.y, y: width - (rect.x + rect.w), w: rect.h, h: rect.w })

// The largest rectangle of the given proportions inside `within`, centred.
function fitAspect(within: Rect, aspect: number): Rect {
	let w = within.w
	let h = w / aspect
	if (h > within.h) {
		h = within.h
		w = h * aspect
	}
	return { x: within.x + (within.w - w) / 2, y: within.y + (within.h - h) / 2, w, h }
}

function drawStrokes(context: CanvasRenderingContext2D, strokes: Stroke[], scale: number, dx: number, dy: number): void {
	context.lineCap = "round"
	context.lineJoin = "round"
	for (const stroke of strokes) {
		context.strokeStyle = stroke.color
		context.lineWidth = stroke.width * scale
		context.beginPath()
		stroke.points.forEach(([x, y], index) => {
			const px = dx + x * scale
			const py = dy + y * scale
			if (index === 0) context.moveTo(px, py)
			else context.lineTo(px, py)
		})
		if (stroke.points.length === 1) context.lineTo(dx + stroke.points[0][0] * scale + 0.01, dy + stroke.points[0][1] * scale)
		context.stroke()
	}
}

export function PhotoEditor(props: { file: File; onCancel: () => void; onDone: (file: File) => void }) {
	const { t } = useSettings()
	const stageRef = useRef<HTMLDivElement | null>(null)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const sourceRef = useRef<HTMLCanvasElement | null>(null)
	const originalRef = useRef<HTMLCanvasElement | null>(null)
	const [size, setSize] = useState<{ w: number; h: number } | null>(null)
	const [crop, setCrop] = useState<Rect | null>(null)
	const [strokes, setStrokes] = useState<Stroke[]>([])
	const [mode, setMode] = useState<Mode>("crop")
	const [aspect, setAspect] = useState<number | null>(null)
	const [color, setColor] = useState(COLORS[2])
	const [brush, setBrush] = useState(1)
	const [failed, setFailed] = useState(false)
	const [saving, setSaving] = useState(false)
	const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
	const dragRef = useRef<Drag | null>(null)

	// Decode once, scaled to the working size, the right way up.
	useEffect(() => {
		let alive = true
		void (async () => {
			try {
				const bitmap = await createImageBitmap(props.file, { imageOrientation: "from-image" })
				const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
				const canvas = canvasOf(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
				canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
				bitmap.close()
				if (!alive) return
				originalRef.current = canvas
				sourceRef.current = canvas
				setSize({ w: canvas.width, h: canvas.height })
				setCrop({ x: 0, y: 0, w: canvas.width, h: canvas.height })
			} catch {
				if (alive) setFailed(true)
			}
		})()
		return () => { alive = false }
	}, [props.file])

	useLayoutEffect(() => {
		const stage = stageRef.current
		if (!stage) return
		const update = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight })
		update()
		const observer = new ResizeObserver(update)
		observer.observe(stage)
		return () => observer.disconnect()
	}, [])

	// Where the picture sits on the stage: scale and offset in CSS pixels.
	const view = size && stageSize.width > 0
		? (() => {
			const scale = Math.min((stageSize.width - STAGE_PADDING * 2) / size.w, (stageSize.height - STAGE_PADDING * 2) / size.h)
			return { scale, x: (stageSize.width - size.w * scale) / 2, y: (stageSize.height - size.h * scale) / 2 }
		})()
		: null

	const paint = useCallback(() => {
		const canvas = canvasRef.current
		const source = sourceRef.current
		if (!canvas || !source || !view || !size || !crop) return
		const ratio = window.devicePixelRatio || 1
		canvas.width = Math.round(stageSize.width * ratio)
		canvas.height = Math.round(stageSize.height * ratio)
		const context = canvas.getContext("2d")
		if (!context) return
		context.setTransform(ratio, 0, 0, ratio, 0, 0)
		context.clearRect(0, 0, stageSize.width, stageSize.height)
		context.drawImage(source, view.x, view.y, size.w * view.scale, size.h * view.scale)
		drawStrokes(context, strokes, view.scale, view.x, view.y)
		// Outside the frame is dimmed; in crop mode the frame has handles.
		const fx = view.x + crop.x * view.scale
		const fy = view.y + crop.y * view.scale
		const fw = crop.w * view.scale
		const fh = crop.h * view.scale
		context.fillStyle = mode === "crop" ? "rgba(0, 0, 0, 0.55)" : "rgba(0, 0, 0, 0.75)"
		context.beginPath()
		context.rect(view.x, view.y, size.w * view.scale, size.h * view.scale)
		context.rect(fx, fy, fw, fh)
		context.fill("evenodd")
		if (mode !== "crop") return
		context.strokeStyle = "rgba(255, 255, 255, 0.9)"
		context.lineWidth = 1.5
		context.strokeRect(fx, fy, fw, fh)
		context.strokeStyle = "rgba(255, 255, 255, 0.35)"
		context.lineWidth = 1
		for (const share of [1 / 3, 2 / 3]) {
			context.beginPath()
			context.moveTo(fx + fw * share, fy)
			context.lineTo(fx + fw * share, fy + fh)
			context.moveTo(fx, fy + fh * share)
			context.lineTo(fx + fw, fy + fh * share)
			context.stroke()
		}
		context.strokeStyle = "#ffffff"
		context.lineWidth = 4
		const arm = Math.min(22, fw / 3, fh / 3)
		for (const [cx, cy, sx, sy] of [[fx, fy, 1, 1], [fx + fw, fy, -1, 1], [fx + fw, fy + fh, -1, -1], [fx, fy + fh, 1, -1]] as const) {
			context.beginPath()
			context.moveTo(cx, cy + sy * arm)
			context.lineTo(cx, cy)
			context.lineTo(cx + sx * arm, cy)
			context.stroke()
		}
	}, [view, size, crop, strokes, mode, stageSize])

	useEffect(() => {
		const frame = window.requestAnimationFrame(paint)
		return () => window.cancelAnimationFrame(frame)
	}, [paint])

	const toImage = (event: ReactPointerEvent<HTMLCanvasElement>): [number, number] | null => {
		if (!view || !size) return null
		const box = event.currentTarget.getBoundingClientRect()
		const x = (event.clientX - box.left - view.x) / view.scale
		const y = (event.clientY - box.top - view.y) / view.scale
		return [Math.max(0, Math.min(size.w, x)), Math.max(0, Math.min(size.h, y))]
	}

	const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		const point = toImage(event)
		if (!point || !size || !crop || !view) return
		event.currentTarget.setPointerCapture(event.pointerId)
		if (mode === "draw") {
			dragRef.current = { kind: "stroke" }
			setStrokes((prev) => prev.concat([{ color, width: BRUSHES[brush] * Math.max(size.w, size.h), points: [point] }]))
			return
		}
		const reach = HANDLE_REACH / view.scale
		const corners: Array<[number, number]> = [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x + crop.w, crop.y + crop.h], [crop.x, crop.y + crop.h]]
		const corner = corners.findIndex(([cx, cy]) => Math.abs(cx - point[0]) <= reach && Math.abs(cy - point[1]) <= reach)
		if (corner >= 0) dragRef.current = { kind: "corner", corner: corner as 0 | 1 | 2 | 3, from: crop }
		else if (point[0] >= crop.x && point[0] <= crop.x + crop.w && point[1] >= crop.y && point[1] <= crop.y + crop.h) dragRef.current = { kind: "move", startX: point[0], startY: point[1], from: crop }
	}

	const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		const drag = dragRef.current
		const point = toImage(event)
		if (!drag || !point || !size) return
		if (drag.kind === "stroke") {
			setStrokes((prev) => {
				const last = prev[prev.length - 1]
				if (!last) return prev
				return prev.slice(0, -1).concat([{ ...last, points: last.points.concat([point]) }])
			})
			return
		}
		if (drag.kind === "move") {
			const from = drag.from
			const x = Math.max(0, Math.min(size.w - from.w, from.x + point[0] - drag.startX))
			const y = Math.max(0, Math.min(size.h - from.h, from.y + point[1] - drag.startY))
			setCrop({ ...from, x, y })
			return
		}
		// A corner moves; the opposite one stays put.
		const from = drag.from
		const anchorX = drag.corner === 0 || drag.corner === 3 ? from.x + from.w : from.x
		const anchorY = drag.corner === 0 || drag.corner === 1 ? from.y + from.h : from.y
		const minSide = Math.min(size.w, size.h) * MIN_CROP_SHARE
		let w = Math.max(minSide, Math.abs(point[0] - anchorX))
		let h = Math.max(minSide, Math.abs(point[1] - anchorY))
		if (aspect) {
			if (w / h > aspect) w = h * aspect
			else h = w / aspect
		}
		const left = drag.corner === 0 || drag.corner === 3
		const top = drag.corner === 0 || drag.corner === 1
		w = Math.min(w, left ? anchorX : size.w - anchorX)
		h = Math.min(h, top ? anchorY : size.h - anchorY)
		if (aspect) {
			if (w / h > aspect) w = h * aspect
			else h = w / aspect
		}
		setCrop({ x: left ? anchorX - w : anchorX, y: top ? anchorY - h : anchorY, w, h })
	}

	const onPointerUp = () => {
		dragRef.current = null
	}

	const pickAspect = (value: number | null) => {
		setAspect(value)
		if (value && crop) setCrop(fitAspect(crop, value))
	}

	const rotate = () => {
		const source = sourceRef.current
		if (!source || !size) return
		const width = size.w
		sourceRef.current = rotateLeft(source)
		setSize({ w: size.h, h: size.w })
		setCrop((current) => (current ? rotateRect(current, width) : current))
		setStrokes((current) => current.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => rotatePoint(point, width)) })))
		if (aspect) setAspect(1 / aspect)
	}

	const reset = () => {
		const original = originalRef.current
		if (!original) return
		sourceRef.current = original
		setSize({ w: original.width, h: original.height })
		setCrop({ x: 0, y: 0, w: original.width, h: original.height })
		setStrokes([])
		setAspect(null)
	}

	async function finish() {
		const source = sourceRef.current
		if (!source || !crop || saving) return
		setSaving(true)
		try {
			const full = canvasOf(source.width, source.height)
			const context = full.getContext("2d")
			if (!context) throw new Error("no canvas")
			context.drawImage(source, 0, 0)
			drawStrokes(context, strokes, 1, 0, 0)
			const out = canvasOf(Math.max(1, Math.round(crop.w)), Math.max(1, Math.round(crop.h)))
			const png = props.file.type === "image/png"
			const outContext = out.getContext("2d")
			if (!outContext) throw new Error("no canvas")
			if (!png) {
				outContext.fillStyle = "#ffffff"
				outContext.fillRect(0, 0, out.width, out.height)
			}
			outContext.drawImage(full, Math.round(crop.x), Math.round(crop.y), out.width, out.height, 0, 0, out.width, out.height)
			const type = png ? "image/png" : "image/jpeg"
			const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, type, JPEG_QUALITY))
			if (!blob) throw new Error("no image")
			const base = props.file.name.replace(/\.[^.]+$/, "") || "photo"
			props.onDone(new File([blob], base + (png ? ".png" : ".jpg"), { type, lastModified: Date.now() }))
		} catch {
			setFailed(true)
			setSaving(false)
		}
	}

	const { onCancel } = props
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancel()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onCancel])

	const aspectLabel = (label: StringKey | string): string => (label.includes(":") ? label : t(label as StringKey))

	return (
		<div className="photo-editor" role="dialog" aria-modal="true" aria-label={t("photoEditor")}>
			<header className="photo-editor-bar">
				<Button variant="text" onClick={props.onCancel}>{t("cancel")}</Button>
				<h2 className="photo-editor-title">{t("photoEditor")}</h2>
				<Button variant="filled" busy={saving} disabled={!size || failed} onClick={() => void finish()}>{t("done")}</Button>
			</header>
			<div className="photo-editor-stage" ref={stageRef}>
				{failed ? <p className="photo-editor-failed">{t("photoEditFailed")}</p> : null}
				<canvas
					ref={canvasRef}
					className={"photo-editor-canvas " + mode}
					style={{ width: stageSize.width + "px", height: stageSize.height + "px" }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				/>
			</div>
			<div className="photo-editor-tools">
				{mode === "crop" ? (
					<div className="photo-editor-row" role="group" aria-label={t("photoAspect")}>
						{ASPECTS.map((item) => (
							<Chip key={String(item.label)} selected={aspect === item.value} onClick={() => pickAspect(item.value)}>{aspectLabel(item.label)}</Chip>
						))}
					</div>
				) : (
					<div className="photo-editor-row" role="group" aria-label={t("photoBrush")}>
						{COLORS.map((swatch) => (
							<button key={swatch} type="button" className={"photo-editor-swatch" + (swatch === color ? " selected" : "")} style={{ background: swatch }} onClick={() => setColor(swatch)} aria-label={swatch} aria-pressed={swatch === color} />
						))}
						<span className="photo-editor-sep" aria-hidden="true" />
						{BRUSHES.map((_width, index) => (
							<button key={index} type="button" className={"photo-editor-brush" + (index === brush ? " selected" : "")} onClick={() => setBrush(index)} aria-label={t("photoBrushSize") + " " + String(index + 1)} aria-pressed={index === brush}>
								<span style={{ width: 6 + index * 5 + "px", height: 6 + index * 5 + "px", background: color }} />
							</button>
						))}
					</div>
				)}
				<div className="photo-editor-row photo-editor-actions">
					<IconButton label={t("photoCrop")} selected={mode === "crop"} onClick={() => setMode("crop")}><ICrop /></IconButton>
					<IconButton label={t("photoDraw")} selected={mode === "draw"} onClick={() => setMode("draw")}><IBrush /></IconButton>
					<IconButton label={t("photoRotate")} onClick={rotate} disabled={!size}><IRotateLeft /></IconButton>
					<IconButton label={t("photoUndo")} onClick={() => setStrokes((prev) => prev.slice(0, -1))} disabled={strokes.length === 0}><IUndo /></IconButton>
					<IconButton label={t("photoReset")} onClick={reset} disabled={!size}><IRefresh /></IconButton>
				</div>
			</div>
		</div>
	)
}
