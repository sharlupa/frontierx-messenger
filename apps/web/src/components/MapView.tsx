import { useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react"
import { latLonAt, tileFor } from "../lib/richmsg"
import { IAdd, ILocation } from "./m3icons"

// A small slippy map from OpenStreetMap tiles: no library, no key. Tiles load
// only where a map is actually shown. With `interactive` the map pans and
// zooms and reports the point under its centre pin.

const TILE = 256
const MIN_ZOOM = 3
const MAX_ZOOM = 19

export function MapView(props: { lat: number; lon: number; zoom?: number; interactive?: boolean; onMove?: (lat: number, lon: number) => void; className?: string; accuracy?: number | null }) {
	const wrapRef = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState({ width: 320, height: 200 })
	const [zoom, setZoom] = useState(props.zoom ?? 16)
	const [center, setCenter] = useState(() => {
		const tile = tileFor(props.lat, props.lon, props.zoom ?? 16)
		return { x: tile.px, y: tile.py }
	})
	const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)

	useEffect(() => {
		const node = wrapRef.current
		if (!node) return
		const measure = () => setSize({ width: node.clientWidth || 320, height: node.clientHeight || 200 })
		measure()
		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(measure)
		observer.observe(node)
		return () => observer.disconnect()
	}, [])

	// A new point from outside recentres the map.
	useEffect(() => {
		const tile = tileFor(props.lat, props.lon, zoom)
		setCenter({ x: tile.px, y: tile.py })
	}, [props.lat, props.lon])

	const report = (x: number, y: number, z: number) => {
		if (!props.onMove) return
		const point = latLonAt(x, y, z)
		props.onMove(point.lat, point.lon)
	}

	const setZoomKeepingCenter = (next: number) => {
		const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
		if (clamped === zoom) return
		const scale = Math.pow(2, clamped - zoom)
		setCenter((current) => ({ x: current.x * scale, y: current.y * scale }))
		setZoom(clamped)
	}

	const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!props.interactive) return
		drag.current = { x: event.clientX, y: event.clientY, cx: center.x, cy: center.y }
		event.currentTarget.setPointerCapture(event.pointerId)
	}
	const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const start = drag.current
		if (!start) return
		setCenter({ x: start.cx - (event.clientX - start.x), y: start.cy - (event.clientY - start.y) })
	}
	const onUp = () => {
		if (!drag.current) return
		drag.current = null
		report(center.x, center.y, zoom)
	}
	const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
		if (!props.interactive) return
		setZoomKeepingCenter(zoom + (event.deltaY < 0 ? 1 : -1))
	}

	useEffect(() => {
		if (props.interactive) report(center.x, center.y, zoom)
	}, [zoom])

	const left = center.x - size.width / 2
	const top = center.y - size.height / 2
	const count = Math.pow(2, zoom)
	const tiles: Array<{ key: string; url: string; x: number; y: number }> = []
	for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.width) / TILE); tx += 1) {
		for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.height) / TILE); ty += 1) {
			if (ty < 0 || ty >= count) continue
			const wrapped = ((tx % count) + count) % count
			tiles.push({ key: zoom + "/" + tx + "/" + ty, url: "https://tile.openstreetmap.org/" + zoom + "/" + wrapped + "/" + ty + ".png", x: tx * TILE - left, y: ty * TILE - top })
		}
	}
	// Accuracy circle in pixels at this zoom (metres per pixel at the latitude).
	const metresPerPixel = (156543.03392 * Math.cos((props.lat * Math.PI) / 180)) / count
	const radius = props.accuracy && !props.interactive ? Math.min(size.width, props.accuracy / metresPerPixel) : 0

	return (
		<div
			ref={wrapRef}
			className={"map-view" + (props.interactive ? " interactive" : "") + (props.className ? " " + props.className : "")}
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
			onWheel={onWheel}
		>
			{tiles.map((tile) => (
				<img key={tile.key} className="map-tile" src={tile.url} alt="" draggable={false} style={{ transform: "translate(" + tile.x + "px," + tile.y + "px)" }} referrerPolicy="strict-origin-when-cross-origin" />
			))}
			{radius > 6 ? <span className="map-accuracy" style={{ width: radius * 2, height: radius * 2 }} aria-hidden="true" /> : null}
			<span className="map-pin" aria-hidden="true">
				<ILocation size={36} />
			</span>
			{props.interactive ? (
				<div className="map-zoom">
					<button type="button" onClick={(event) => { event.stopPropagation(); setZoomKeepingCenter(zoom + 1) }} aria-label="+"><IAdd size={18} /></button>
					<button type="button" onClick={(event) => { event.stopPropagation(); setZoomKeepingCenter(zoom - 1) }} aria-label="-"><span className="map-minus" /></button>
				</div>
			) : null}
			<a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener" onPointerDown={(event) => event.stopPropagation()}>© OpenStreetMap</a>
		</div>
	)
}
