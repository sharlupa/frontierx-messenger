// Material 3 Expressive building blocks: the shape-morphing loading indicator
// and wavy progress indicators (linear and circular). Shapes and waves are
// computed here rather than drawn from assets, so they follow the theme
// colour (currentColor) and scale to any size. Every animation stops when the
// user asked for less motion.

import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

const TAU = Math.PI * 2

// Motion preference: the OS setting or the in-app "minimal animations" option
// (data-motion="reduced" on <html>).
export function prefersReducedMotion(): boolean {
	if (typeof document === "undefined") return true
	if (document.documentElement.dataset.motion === "reduced") return true
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(prefersReducedMotion)
	useEffect(() => {
		const update = () => setReduced(prefersReducedMotion())
		const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null
		media?.addEventListener("change", update)
		const observer = new MutationObserver(update)
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] })
		return () => {
			media?.removeEventListener("change", update)
			observer.disconnect()
		}
	}, [])
	return reduced
}

// Runs `frame` on every animation frame while `active`, with elapsed ms.
function useFrames(active: boolean, frame: (elapsed: number) => void): void {
	const frameRef = useRef(frame)
	frameRef.current = frame
	useEffect(() => {
		if (!active) return
		let handle = 0
		const start = performance.now()
		const tick = (now: number) => {
			// The first frame can carry a timestamp from just before start.
			frameRef.current(Math.max(0, now - start))
			handle = requestAnimationFrame(tick)
		}
		handle = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(handle)
	}, [active])
}

// --- Loading indicator ------------------------------------------------------

// Each shape is a radius function of the angle, normalised to a max of 1, so
// any two shapes can be blended point by point.
type ShapeFn = (theta: number) => number
const lobes = (count: number, depth: number, sharp = 1): ShapeFn => (theta) => {
	const wave = Math.cos(count * theta)
	const shaped = Math.sign(wave) * Math.pow(Math.abs(wave), sharp)
	return (1 - depth) + depth * (shaped + 1) / 2
}
const oval = (ratio: number): ShapeFn => (theta) => {
	const a = 1
	const b = 1 / ratio
	return (a * b) / Math.sqrt(Math.pow(b * Math.cos(theta), 2) + Math.pow(a * Math.sin(theta), 2))
}
const pill: ShapeFn = (theta) => {
	// Stadium: a superellipse stretched along one axis.
	const n = 4
	const c = Math.abs(Math.cos(theta))
	const s = Math.abs(Math.sin(theta)) * 1.45
	return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n)
}
// Soft burst, cookie, pentagon, pill, sunny, oval, clover, twelve-sided cookie.
const SHAPES: ShapeFn[] = [lobes(10, 0.2, 0.6), lobes(9, 0.12), lobes(5, 0.16, 0.8), pill, lobes(8, 0.08), oval(1.35), lobes(8, 0.2, 0.5), lobes(12, 0.09)]
const SAMPLES = 90
const MORPH_MS = 650
const HOLD_MS = 150

function shapePoints(fn: ShapeFn): number[] {
	const radii: number[] = []
	let max = 0
	for (let i = 0; i < SAMPLES; i++) {
		const r = fn((i / SAMPLES) * TAU)
		radii.push(r)
		if (r > max) max = r
	}
	return radii.map((r) => r / max)
}
export const SHAPE_RADII = SHAPES.map(shapePoints)

// A spring with a little overshoot, the M3 Expressive "spatial" feel.
export function springEase(t: number): number {
	if (t <= 0) return 0
	if (t >= 1) return 1
	return 1 - Math.exp(-7 * t) * Math.cos(9 * t)
}

export function radiiPath(radii: number[], size: number, rotation: number, scale = 1): string {
	const c = size / 2
	const r0 = (size / 2) * scale
	let d = ""
	for (let i = 0; i < radii.length; i++) {
		const angle = (i / radii.length) * TAU + rotation
		const x = c + Math.cos(angle) * radii[i] * r0
		const y = c + Math.sin(angle) * radii[i] * r0
		d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2)
	}
	return d + "Z"
}

export function LoadingIndicator(props: { size?: number; contained?: boolean; label?: string; className?: string }) {
	const size = props.size ?? 48
	const reduced = useReducedMotion()
	const pathRef = useRef<SVGPathElement>(null)
	useFrames(!reduced, (elapsed) => {
		const cycle = MORPH_MS + HOLD_MS
		const step = Math.floor(elapsed / cycle)
		const local = Math.min(1, (elapsed % cycle) / MORPH_MS)
		const from = SHAPE_RADII[step % SHAPE_RADII.length]
		const to = SHAPE_RADII[(step + 1) % SHAPE_RADII.length]
		const k = springEase(local)
		const blended = from.map((r, i) => r + (to[i] - r) * k)
		// Steady spin plus a quarter-turn kick on every morph.
		const rotation = (elapsed / 4500) * TAU + (step + k) * (Math.PI / 2)
		pathRef.current?.setAttribute("d", radiiPath(blended, size, rotation, props.contained ? 0.62 : 0.96))
	})
	const initial = radiiPath(SHAPE_RADII[1], size, 0, props.contained ? 0.62 : 0.96)
	return (
		<span
			className={"m3-loader" + (props.contained ? " contained" : "") + (props.className ? " " + props.className : "")}
			role="progressbar"
			aria-label={props.label}
			style={{ width: size, height: size }}
		>
			<svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
				<path ref={pathRef} d={initial} fill="currentColor" />
			</svg>
		</span>
	)
}

// A loader with an optional caption, centred in its container.
export function LoadingBlock(props: { label?: string; size?: number }) {
	return (
		<div className="m3-loading-block" aria-live="polite">
			<LoadingIndicator size={props.size ?? 48} contained label={props.label} />
			{props.label ? <span className="m3-loading-label">{props.label}</span> : null}
		</div>
	)
}

// --- Linear wavy progress -----------------------------------------------------

const WAVELENGTH = 22
const GAP = 5

function wavePath(from: number, to: number, mid: number, amplitude: number): string {
	let d = `M${from.toFixed(2)} ${mid.toFixed(2)}`
	for (let x = from; x <= to; x += 2) {
		const y = mid + Math.sin(((x - from) / WAVELENGTH) * TAU) * amplitude
		d += `L${x.toFixed(2)} ${y.toFixed(2)}`
	}
	return d
}

export function WavyProgress(props: { value?: number | null; label?: string; className?: string; thickness?: number }) {
	const wrapRef = useRef<HTMLSpanElement>(null)
	const [width, setWidth] = useState(0)
	const reduced = useReducedMotion()
	useEffect(() => {
		const node = wrapRef.current
		if (!node) return
		const measure = () => setWidth(node.getBoundingClientRect().width)
		measure()
		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(measure)
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	const thickness = props.thickness ?? 4
	const height = thickness * 3 + 4
	const mid = height / 2
	const amplitude = reduced ? 0 : thickness * 0.75
	const determinate = typeof props.value === "number"
	const value = determinate ? Math.max(0, Math.min(1, props.value as number)) : 0
	const active = Math.max(thickness, value * width)
	const trackStart = determinate ? Math.min(width, active + GAP) : 0
	// The wave is drawn one wavelength wider than needed and slides left by
	// exactly one wavelength, so the loop is seamless.
	const wave = width > 0 ? wavePath(-WAVELENGTH, width + WAVELENGTH, mid, amplitude) : ""
	const clipId = useRef("wv" + Math.random().toString(36).slice(2)).current
	return (
		<span
			ref={wrapRef}
			className={"m3-wavy" + (determinate ? "" : " indeterminate") + (props.className ? " " + props.className : "")}
			role="progressbar"
			aria-label={props.label}
			aria-valuemin={determinate ? 0 : undefined}
			aria-valuemax={determinate ? 100 : undefined}
			aria-valuenow={determinate ? Math.round(value * 100) : undefined}
			style={{ height }}
		>
			{width > 0 ? (
				<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
					<defs>
						<clipPath id={clipId}>
							{determinate ? <rect className="m3-wavy-clip" x={0} y={0} width={active} height={height} /> : <rect className="m3-wavy-sweep" x={0} y={0} width={width * 0.42} height={height} />}
						</clipPath>
					</defs>
					{determinate && trackStart < width - thickness ? (
						<>
							<line className="m3-wavy-track" x1={trackStart} y1={mid} x2={width - thickness / 2} y2={mid} strokeWidth={thickness} strokeLinecap="round" />
							<circle className="m3-wavy-stop" cx={width - thickness / 2} cy={mid} r={thickness / 2} />
						</>
					) : null}
					{!determinate ? <line className="m3-wavy-track" x1={thickness / 2} y1={mid} x2={width - thickness / 2} y2={mid} strokeWidth={thickness} strokeLinecap="round" /> : null}
					<g clipPath={`url(#${clipId})`}>
						<path className="m3-wavy-wave" d={wave} fill="none" stroke="currentColor" strokeWidth={thickness} strokeLinecap="round" style={{ ["--wave-shift" as string]: `-${WAVELENGTH}px` }} />
					</g>
				</svg>
			) : null}
		</span>
	)
}

// --- Circular wavy progress ---------------------------------------------------

export function WavyCircle(props: { value?: number | null; size?: number; label?: string; className?: string; children?: ReactNode }) {
	const size = props.size ?? 40
	const stroke = Math.max(3, size / 11)
	const radius = size / 2 - stroke - 1.5
	const waves = Math.max(8, Math.round(size / 4))
	const amplitude = stroke * 0.32
	const reduced = useReducedMotion()
	const determinate = typeof props.value === "number"
	const value = determinate ? Math.max(0, Math.min(1, props.value as number)) : 0.28
	const activeRef = useRef<SVGPathElement>(null)
	const trackRef = useRef<SVGPathElement>(null)
	const valueRef = useRef(value)
	valueRef.current = value

	const build = (phase: number, spin: number) => {
		const c = size / 2
		const sweep = Math.max(0.02, valueRef.current) * TAU
		const gap = determinate && valueRef.current < 1 ? (stroke * 2.2) / radius : 0
		const start = -Math.PI / 2 + spin
		let active = ""
		// Enough points per wave that the crests stay round at any size.
		const steps = Math.max(32, Math.round((sweep / TAU) * waves * 12))
		for (let i = 0; i <= steps; i++) {
			const a = start + (i / steps) * sweep
			const r = radius + (reduced ? 0 : Math.sin(a * waves + phase) * amplitude)
			active += (i === 0 ? "M" : "L") + (c + Math.cos(a) * r).toFixed(2) + " " + (c + Math.sin(a) * r).toFixed(2)
		}
		activeRef.current?.setAttribute("d", active)
		const trackFrom = start + sweep + gap
		const trackTo = start + TAU - gap
		let track = ""
		if (trackTo > trackFrom) {
			const tSteps = Math.max(8, Math.round((trackTo - trackFrom) * 10))
			for (let i = 0; i <= tSteps; i++) {
				const a = trackFrom + (i / tSteps) * (trackTo - trackFrom)
				track += (i === 0 ? "M" : "L") + (c + Math.cos(a) * radius).toFixed(2) + " " + (c + Math.sin(a) * radius).toFixed(2)
			}
		}
		trackRef.current?.setAttribute("d", track)
	}
	useFrames(!reduced, (elapsed) => build(elapsed / 180, determinate ? 0 : (elapsed / 900) * TAU))
	useEffect(() => {
		if (reduced) build(0, 0)
	})
	return (
		<span
			className={"m3-wavy-circle" + (props.className ? " " + props.className : "")}
			role="progressbar"
			aria-label={props.label}
			aria-valuemin={determinate ? 0 : undefined}
			aria-valuemax={determinate ? 100 : undefined}
			aria-valuenow={determinate ? Math.round(value * 100) : undefined}
			style={{ width: size, height: size }}
		>
			<svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
				<path ref={trackRef} className="m3-wavy-track" fill="none" strokeWidth={stroke} strokeLinecap="round" />
				<path ref={activeRef} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
			</svg>
			{props.children ? <span className="m3-wavy-circle-label">{props.children}</span> : null}
		</span>
	)
}

// --- Decorative morphing shape ----------------------------------------------

// A large, slow morph for backgrounds and empty states, like the ones on the
// FrontierX site. It pauses while off screen and stays still for reduced motion.
export function MorphBlob(props: { size?: number; className?: string; shapes?: number[]; morphMs?: number; holdMs?: number }) {
	const size = props.size ?? 240
	const order = props.shapes ?? [1, 0, 2, 5, 4]
	const morphMs = props.morphMs ?? 1100
	const holdMs = props.holdMs ?? 1500
	const reduced = useReducedMotion()
	const wrapRef = useRef<HTMLSpanElement>(null)
	const pathRef = useRef<SVGPathElement>(null)
	const [visible, setVisible] = useState(true)
	useEffect(() => {
		const node = wrapRef.current
		if (!node || typeof IntersectionObserver === "undefined") return
		const observer = new IntersectionObserver((entries) => setVisible(entries[0]?.isIntersecting ?? true))
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	useFrames(!reduced && visible, (elapsed) => {
		const cycle = morphMs + holdMs
		const step = Math.floor(elapsed / cycle)
		const k = springEase(Math.min(1, (elapsed % cycle) / morphMs))
		const from = SHAPE_RADII[order[step % order.length] % SHAPE_RADII.length]
		const to = SHAPE_RADII[order[(step + 1) % order.length] % SHAPE_RADII.length]
		const blended = from.map((r, i) => r + (to[i] - r) * k)
		const rotation = (elapsed / 24000) * TAU + (step + k) * (Math.PI / 4)
		pathRef.current?.setAttribute("d", radiiPath(blended, size, rotation, 0.98))
	})
	return (
		<span ref={wrapRef} className={"m3-blob" + (props.className ? " " + props.className : "")} aria-hidden="true">
			<svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%">
				<path ref={pathRef} d={radiiPath(SHAPE_RADII[order[0] % SHAPE_RADII.length], size, 0, 0.98)} />
			</svg>
		</span>
	)
}

// Two slow shapes behind the sign-in, sign-up and invite cards.
export function AuthBackdrop() {
	return (
		<span className="auth-backdrop" aria-hidden="true">
			<MorphBlob className="auth-blob one" size={320} shapes={[1, 6, 0, 7]} />
			<MorphBlob className="auth-blob two" size={220} shapes={[2, 4, 6, 3]} morphMs={950} holdMs={1300} />
		</span>
	)
}
