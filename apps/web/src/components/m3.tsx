// Material 3 Expressive building blocks shared by every dialog and page:
// sheets that morph in from a rounder shape, segmented list groups whose items
// reshape under the pointer, icons in containers that morph between the M3
// shapes, switches, chips, banners, text fields and menus. Colours come from
// the active theme and accent; motion follows the reduced-motion setting.

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { SHAPE_RADII, radiiPath, springEase, useReducedMotion } from "./Expressive"
import { IChevronRight, IClose, IBack, ICheck } from "./m3icons"

// --- shapes -------------------------------------------------------------------

// Index into the M3 shape set of Expressive.tsx: soft burst, cookie, pentagon,
// pill, sunny, oval, clover, twelve-sided cookie.
export type ShapeName = "burst" | "cookie" | "pentagon" | "pill" | "sunny" | "oval" | "clover" | "cookie12" | "circle"
const SHAPE_INDEX: Record<Exclude<ShapeName, "circle">, number> = { burst: 0, cookie: 1, pentagon: 2, pill: 3, sunny: 4, oval: 5, clover: 6, cookie12: 7 }
const CIRCLE = new Array(SHAPE_RADII[0].length).fill(1)

function radiiOf(shape: ShapeName): number[] {
	return shape === "circle" ? CIRCLE : SHAPE_RADII[SHAPE_INDEX[shape]]
}

// The shape each one turns into when it reacts: always a visibly different one.
const PARTNER: Record<ShapeName, ShapeName> = {
	burst: "cookie",
	cookie: "clover",
	pentagon: "cookie12",
	pill: "sunny",
	sunny: "burst",
	oval: "cookie",
	clover: "cookie12",
	cookie12: "sunny",
	circle: "cookie",
}

export type Tone = "primary" | "secondary" | "tertiary" | "error" | "neutral" | "blue" | "green" | "orange" | "pink" | "violet" | "teal"

// An icon in a tonal container shaped like an M3 shape. While the row it sits
// in is hovered or pressed (or the icon itself, with `hoverable`), the
// container morphs into a second shape on a spring and turns a little, the way
// M3 Expressive icons react. With `intro` it also morphs in when it appears.
export function ShapeIcon(props: { icon: ReactNode; shape?: ShapeName; morphTo?: ShapeName; tone?: Tone; size?: number; active?: boolean; hoverable?: boolean; intro?: boolean; className?: string }) {
	const size = props.size ?? 40
	const shape = props.shape ?? "cookie"
	const target = props.morphTo && props.morphTo !== shape ? props.morphTo : PARTNER[shape]
	const reduced = useReducedMotion()
	const pathRef = useRef<SVGPathElement>(null)
	const progress = useRef(props.intro && !reduced ? 1 : 0)
	const frame = useRef(0)
	const [hover, setHover] = useState(false)
	const active = Boolean(props.active) || hover

	useEffect(() => {
		const from = radiiOf(shape)
		const to = radiiOf(target)
		const goal = active ? 1 : 0
		const draw = (k: number) => {
			const blended = from.map((r, i) => r + (to[i] - r) * k)
			pathRef.current?.setAttribute("d", radiiPath(blended, size, k * (Math.PI / 5), 1))
		}
		if (reduced) {
			progress.current = goal
			draw(goal)
			return
		}
		cancelAnimationFrame(frame.current)
		const start = performance.now()
		const origin = progress.current
		const duration = 520
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / duration)
			const k = origin + (goal - origin) * springEase(t)
			progress.current = k
			draw(k)
			if (t < 1) frame.current = requestAnimationFrame(tick)
		}
		frame.current = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(frame.current)
	}, [active, shape, target, size, reduced])

	const hoverProps = props.hoverable ? { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) } : {}
	// The first outline only; after that the animation owns the path.
	const [initialPath] = useState(() => (progress.current === 1 ? radiiPath(radiiOf(target), size, Math.PI / 5, 1) : radiiPath(radiiOf(shape), size, 0, 1)))
	return (
		<span className={"m3-shape-icon tone-" + (props.tone ?? "primary") + (props.hoverable ? " hoverable" : "") + (props.className ? " " + props.className : "")} style={{ width: size, height: size }} aria-hidden="true" {...hoverProps}>
			<svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
				<path ref={pathRef} d={initialPath} />
			</svg>
			<span className="m3-shape-icon-glyph">{props.icon}</span>
		</span>
	)
}

// --- sheets -------------------------------------------------------------------

type SheetStackEntry = { id: number; close: () => void }
const sheetStack: SheetStackEntry[] = []
let sheetCounter = 0

const SheetContext = createContext<{ requestClose: () => void } | null>(null)

// Closes the sheet this component sits in (with its exit animation).
export function useSheetClose(): () => void {
	const ctx = useContext(SheetContext)
	return ctx ? ctx.requestClose : () => undefined
}

function focusable(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

export type SheetSize = "sm" | "md" | "lg" | "xl"

// A dialog as an M3 Expressive sheet: it grows out of a rounder, smaller shape
// on a spring and settles into its extra-large corners; on phones it is a
// bottom sheet that can be dragged down to close. Focus stays inside while it
// is open and returns where it came from.
export function Sheet(props: {
	title?: ReactNode
	subtitle?: ReactNode
	icon?: ReactNode
	iconShape?: ShapeName
	iconTone?: Tone
	onClose: () => void
	size?: SheetSize
	actions?: ReactNode
	headerTrailing?: ReactNode
	children?: ReactNode
	className?: string
	bodyClassName?: string
	dismissible?: boolean
	hideHeader?: boolean
	onBack?: () => void
	role?: "dialog" | "alertdialog"
}) {
	const { onClose } = props
	const [closing, setClosing] = useState(false)
	const [drag, setDrag] = useState(0)
	const sheetRef = useRef<HTMLElement>(null)
	const titleId = useId()
	const idRef = useRef(0)
	const dragStart = useRef<number | null>(null)
	const reduced = useReducedMotion()
	const dismissible = props.dismissible !== false

	const requestClose = useCallback(() => {
		if (closing) return
		if (reduced) {
			onClose()
			return
		}
		setClosing(true)
		window.setTimeout(onClose, 190)
	}, [closing, onClose, reduced])

	useEffect(() => {
		sheetCounter += 1
		const entry = { id: sheetCounter, close: () => requestCloseRef.current() }
		idRef.current = entry.id
		sheetStack.push(entry)
		const previous = document.activeElement as HTMLElement | null
		const root = sheetRef.current
		if (root) {
			const preferred = root.querySelector<HTMLElement>("[data-autofocus]")
			const first = preferred ?? focusable(root).find((el) => !el.classList.contains("m3-sheet-close")) ?? root
			window.setTimeout(() => first.focus({ preventScroll: true }), 30)
		}
		document.body.classList.add("m3-sheet-open")
		return () => {
			const index = sheetStack.findIndex((item) => item.id === entry.id)
			if (index >= 0) sheetStack.splice(index, 1)
			if (sheetStack.length === 0) document.body.classList.remove("m3-sheet-open")
			if (previous && typeof previous.focus === "function") previous.focus({ preventScroll: true })
		}
	}, [])

	const requestCloseRef = useRef(requestClose)
	requestCloseRef.current = requestClose

	const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		const top = sheetStack[sheetStack.length - 1]
		if (!top || top.id !== idRef.current) return
		if (event.key === "Escape" && dismissible) {
			event.stopPropagation()
			requestClose()
			return
		}
		if (event.key === "Tab" && sheetRef.current) {
			const items = focusable(sheetRef.current)
			if (items.length === 0) return
			const first = items[0]
			const last = items[items.length - 1]
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault()
				last.focus()
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault()
				first.focus()
			}
		}
	}

	// Pressing on the scrim closes; the press must start there too, so a text
	// selection that ends outside the sheet never throws its content away.
	const pressedOnScrim = useRef(false)
	const onScrimDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		pressedOnScrim.current = event.target === event.currentTarget
	}
	const onScrimClick = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (dismissible && pressedOnScrim.current && event.target === event.currentTarget) requestClose()
		pressedOnScrim.current = false
	}

	// Bottom-sheet drag on phones.
	const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!dismissible) return
		dragStart.current = event.clientY
		event.currentTarget.setPointerCapture(event.pointerId)
	}
	const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (dragStart.current === null) return
		setDrag(Math.max(0, event.clientY - dragStart.current))
	}
	const onHandleUp = () => {
		if (dragStart.current === null) return
		dragStart.current = null
		if (drag > 110) requestClose()
		setDrag(0)
	}

	const size = props.size ?? "md"
	const style: CSSProperties | undefined = drag > 0 ? { transform: "translateY(" + drag + "px)", transition: "none" } : undefined
	const body = (
		<div className={"m3-scrim" + (closing ? " closing" : "")} role="presentation" onPointerDown={onScrimDown} onClick={onScrimClick}>
			<SheetContext.Provider value={{ requestClose }}>
				<section
					ref={sheetRef}
					className={"m3-sheet size-" + size + (closing ? " closing" : "") + (props.className ? " " + props.className : "")}
					role={props.role ?? "dialog"}
					aria-modal="true"
					aria-labelledby={props.title ? titleId : undefined}
					tabIndex={-1}
					onKeyDown={onKeyDown}
					style={style}
				>
					<div className="m3-sheet-handle" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} aria-hidden="true">
						<span />
					</div>
					{props.hideHeader ? null : (
						<header className="m3-sheet-header">
							{props.onBack ? (
								<IconButton label="Back" onClick={props.onBack} className="m3-sheet-back">
									<IBack />
								</IconButton>
							) : props.icon ? (
								<ShapeIcon icon={props.icon} shape={props.iconShape ?? "cookie"} tone={props.iconTone ?? "primary"} size={44} hoverable intro />
							) : null}
							<div className="m3-sheet-titles">
								{props.title ? <h2 id={titleId} className="m3-sheet-title">{props.title}</h2> : null}
								{props.subtitle ? <p className="m3-sheet-subtitle">{props.subtitle}</p> : null}
							</div>
							{props.headerTrailing}
							{dismissible ? (
								<IconButton label="Close" onClick={requestClose} className="m3-sheet-close" variant="tonal">
									<IClose />
								</IconButton>
							) : null}
						</header>
					)}
					<div className={"m3-sheet-body" + (props.bodyClassName ? " " + props.bodyClassName : "")}>{props.children}</div>
					{props.actions ? <footer className="m3-sheet-actions">{props.actions}</footer> : null}
				</section>
			</SheetContext.Provider>
		</div>
	)
	return createPortal(body, document.body)
}

// --- buttons --------------------------------------------------------------------

export function IconButton(props: {
	label: string
	onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void
	children: ReactNode
	variant?: "standard" | "tonal" | "filled" | "outlined"
	size?: "s" | "m" | "l"
	selected?: boolean
	disabled?: boolean
	className?: string
	type?: "button" | "submit"
}) {
	return (
		<button
			type={props.type ?? "button"}
			className={"m3-icon-btn " + (props.variant ?? "standard") + " size-" + (props.size ?? "m") + (props.selected ? " selected" : "") + (props.className ? " " + props.className : "")}
			aria-label={props.label}
			title={props.label}
			aria-pressed={props.selected === undefined ? undefined : props.selected}
			disabled={props.disabled}
			onClick={props.onClick}
		>
			{props.children}
		</button>
	)
}

export function Button(props: {
	children: ReactNode
	onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void
	variant?: "filled" | "tonal" | "outlined" | "text" | "danger"
	icon?: ReactNode
	disabled?: boolean
	type?: "button" | "submit"
	className?: string
	busy?: boolean
	autoFocus?: boolean
}) {
	return (
		<button
			type={props.type ?? "button"}
			className={"m3-btn " + (props.variant ?? "filled") + (props.className ? " " + props.className : "")}
			disabled={props.disabled || props.busy}
			onClick={props.onClick}
			data-autofocus={props.autoFocus ? "" : undefined}
			aria-busy={props.busy || undefined}
		>
			{props.icon ? <span className="m3-btn-icon" aria-hidden="true">{props.icon}</span> : null}
			<span>{props.children}</span>
		</button>
	)
}

// --- lists -----------------------------------------------------------------------

// A segmented group: the first and last item carry the large corners, items in
// between small ones, separated by thin gaps instead of lines.
export function ListGroup(props: { label?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<div className={"m3-list-section" + (props.className ? " " + props.className : "")}>
			{props.label ? <div className="m3-list-label">{props.label}</div> : null}
			<div className="m3-list-group" role="list">{props.children}</div>
		</div>
	)
}

export function ListItem(props: {
	title: ReactNode
	subtitle?: ReactNode
	icon?: ReactNode
	shape?: ShapeName
	tone?: Tone
	leading?: ReactNode
	trailing?: ReactNode
	onClick?: () => void
	href?: string
	chevron?: boolean
	danger?: boolean
	selected?: boolean
	disabled?: boolean
	className?: string
	multiline?: boolean
}) {
	const [hover, setHover] = useState(false)
	const interactive = Boolean(props.onClick || props.href)
	const content = (
		<>
			{props.leading ?? (props.icon ? <ShapeIcon icon={props.icon} shape={props.shape ?? "circle"} tone={props.danger ? "error" : props.tone ?? "primary"} active={hover || props.selected} /> : null)}
			<span className="m3-list-text">
				<span className="m3-list-title">{props.title}</span>
				{props.subtitle ? <span className={"m3-list-subtitle" + (props.multiline ? " multiline" : "")}>{props.subtitle}</span> : null}
			</span>
			{props.trailing ? <span className="m3-list-trailing">{props.trailing}</span> : null}
			{props.chevron ? <span className="m3-list-chevron" aria-hidden="true"><IChevronRight size={18} /></span> : null}
		</>
	)
	const className = "m3-list-item" + (interactive ? " interactive" : "") + (props.danger ? " danger" : "") + (props.selected ? " selected" : "") + (props.className ? " " + props.className : "")
	// Every row with an icon reacts to the pointer; only interactive rows also
	// take focus and change their background.
	const hoverProps = interactive
		? { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false), onFocus: () => setHover(true), onBlur: () => setHover(false) }
		: { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) }
	if (props.href) {
		return (
			<a className={className} href={props.href} target="_blank" rel="noreferrer noopener" role="listitem" {...hoverProps}>
				{content}
			</a>
		)
	}
	if (props.onClick) {
		return (
			<button type="button" className={className} onClick={props.onClick} disabled={props.disabled} role="listitem" {...hoverProps}>
				{content}
			</button>
		)
	}
	return (
		<div className={className} role="listitem" {...hoverProps}>
			{content}
		</div>
	)
}

// --- switch --------------------------------------------------------------------------

export function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label?: string; disabled?: boolean; id?: string }) {
	return (
		<button
			type="button"
			role="switch"
			id={props.id}
			aria-checked={props.checked}
			aria-label={props.label}
			disabled={props.disabled}
			className={"m3-switch" + (props.checked ? " on" : "")}
			onClick={(event) => {
				event.stopPropagation()
				props.onChange(!props.checked)
			}}
		>
			<span className="m3-switch-thumb">{props.checked ? <ICheck size={14} /> : <IClose size={12} />}</span>
		</button>
	)
}

export function SwitchItem(props: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; shape?: ShapeName; tone?: Tone; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
	return (
		<ListItem
			title={props.title}
			subtitle={props.subtitle}
			icon={props.icon}
			shape={props.shape}
			tone={props.tone}
			disabled={props.disabled}
			onClick={props.disabled ? undefined : () => props.onChange(!props.checked)}
			trailing={<Switch checked={props.checked} onChange={props.onChange} disabled={props.disabled} label={typeof props.title === "string" ? props.title : undefined} />}
		/>
	)
}

// --- chips -------------------------------------------------------------------------

export function Chip(props: { children: ReactNode; selected?: boolean; onClick?: () => void; icon?: ReactNode; className?: string }) {
	return (
		<button type="button" className={"m3-chip" + (props.selected ? " selected" : "") + (props.className ? " " + props.className : "")} aria-pressed={props.selected} onClick={props.onClick}>
			{props.selected ? <span className="m3-chip-icon" aria-hidden="true"><ICheck size={16} /></span> : props.icon ? <span className="m3-chip-icon" aria-hidden="true">{props.icon}</span> : null}
			<span>{props.children}</span>
		</button>
	)
}

// --- banners and notes ------------------------------------------------------------------

export function Banner(props: { tone?: "info" | "warning" | "error" | "success"; icon?: ReactNode; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
	return (
		<div className={"m3-banner tone-" + (props.tone ?? "info") + (props.className ? " " + props.className : "")} role={props.tone === "error" ? "alert" : "status"}>
			{props.icon ? <span className="m3-banner-icon" aria-hidden="true">{props.icon}</span> : null}
			<div className="m3-banner-text">
				{props.title ? <div className="m3-banner-title">{props.title}</div> : null}
				{props.children ? <div className="m3-banner-body">{props.children}</div> : null}
			</div>
			{props.actions ? <div className="m3-banner-actions">{props.actions}</div> : null}
		</div>
	)
}

// --- text fields ----------------------------------------------------------------------

export function TextField(props: {
	label: string
	value: string
	onChange: (value: string) => void
	type?: string
	autoFocus?: boolean
	autoComplete?: string
	inputMode?: "text" | "numeric" | "email" | "tel" | "search" | "decimal"
	maxLength?: number
	supporting?: ReactNode
	error?: string | null
	trailing?: ReactNode
	placeholder?: string
	multiline?: boolean
	onEnter?: () => void
	id?: string
	className?: string
	spellCheck?: boolean
	disabled?: boolean
}) {
	const autoId = useId()
	const id = props.id ?? autoId
	const common = {
		id,
		value: props.value,
		placeholder: props.placeholder ?? " ",
		maxLength: props.maxLength,
		disabled: props.disabled,
		spellCheck: props.spellCheck,
		"aria-invalid": props.error ? true : undefined,
		"aria-describedby": props.error || props.supporting ? id + "-support" : undefined,
		"data-autofocus": props.autoFocus ? "" : undefined,
	}
	return (
		<div className={"m3-field" + (props.error ? " invalid" : "") + (props.className ? " " + props.className : "")}>
			<div className="m3-field-box">
				{props.multiline ? (
					<textarea {...common} rows={3} onChange={(event) => props.onChange(event.target.value)} />
				) : (
					<input
						{...common}
						type={props.type ?? "text"}
						autoComplete={props.autoComplete}
						inputMode={props.inputMode}
						onChange={(event) => props.onChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && props.onEnter) {
								event.preventDefault()
								props.onEnter()
							}
						}}
					/>
				)}
				<label htmlFor={id}>{props.label}</label>
				{props.trailing ? <span className="m3-field-trailing">{props.trailing}</span> : null}
			</div>
			{props.error || props.supporting ? (
				<div id={id + "-support"} className="m3-field-support">
					{props.error ?? props.supporting}
				</div>
			) : null}
		</div>
	)
}

// --- menus -----------------------------------------------------------------------------

export type MenuItemSpec = { key: string; label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode }

// A floating menu anchored to an element, kept inside the viewport.
export function Menu(props: { anchor: HTMLElement | null; items: MenuItemSpec[]; onClose: () => void; align?: "start" | "end"; placement?: "below" | "above" }) {
	const ref = useRef<HTMLDivElement>(null)
	const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
	useLayoutEffect(() => {
		const anchor = props.anchor
		const menu = ref.current
		if (!anchor || !menu) return
		const rect = anchor.getBoundingClientRect()
		const width = menu.offsetWidth
		const height = menu.offsetHeight
		const margin = 8
		let left = props.align === "start" ? rect.left : rect.right - width
		left = Math.max(margin, Math.min(window.innerWidth - width - margin, left))
		const below = rect.bottom + 6
		const above = rect.top - height - 6
		const top = props.placement === "above" ? (above > margin ? above : below) : below + height > window.innerHeight - margin && above > margin ? above : below
		setStyle({ left, top: Math.max(margin, top), transformOrigin: (top < rect.top ? "bottom " : "top ") + (props.align === "start" ? "left" : "right") })
	}, [props.anchor, props.align, props.placement, props.items.length])
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose()
		}
		window.addEventListener("keydown", onKey)
		window.setTimeout(() => ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus(), 20)
		return () => window.removeEventListener("keydown", onKey)
	}, [])
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
		event.preventDefault()
		const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
		const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
		buttons[next]?.focus()
	}
	return createPortal(
		<>
			<div className="m3-menu-scrim" onClick={props.onClose} />
			<div ref={ref} className="m3-menu" role="menu" style={style} onKeyDown={onKeyDown}>
				{props.items.map((item) => (
					<button
						key={item.key}
						type="button"
						role="menuitem"
						className={"m3-menu-item" + (item.danger ? " danger" : "")}
						disabled={item.disabled}
						onClick={() => {
							props.onClose()
							item.onSelect()
						}}
					>
						{item.icon ? <span className="m3-menu-icon" aria-hidden="true">{item.icon}</span> : null}
						<span className="m3-menu-label">{item.label}</span>
						{item.hint ? <span className="m3-menu-hint">{item.hint}</span> : null}
					</button>
				))}
			</div>
		</>,
		document.body,
	)
}

// --- misc -----------------------------------------------------------------------------

export function Avatar(props: { src?: string | null; label: string; seed?: string; size?: number; shape?: "circle" | "group" | "channel"; className?: string }) {
	const size = props.size ?? 40
	const initials = (() => {
		const parts = props.label.trim().split(/\s+/).filter(Boolean)
		if (parts.length === 0) return "?"
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
		return (parts[0][0] + parts[1][0]).toUpperCase()
	})()
	const colors = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#f2a45c"]
	let hash = 0
	for (const ch of props.seed ?? props.label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
	const shapeClass = props.shape && props.shape !== "circle" ? " shape-" + props.shape : ""
	const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.38) }
	if (props.src) return <img className={"m3-avatar" + shapeClass + (props.className ? " " + props.className : "")} src={props.src} alt="" style={style} />
	return (
		<span className={"m3-avatar" + shapeClass + (props.className ? " " + props.className : "")} style={{ ...style, background: colors[hash % colors.length] }} aria-hidden="true">
			{initials}
		</span>
	)
}

export function Badge(props: { count: number; className?: string }) {
	if (props.count <= 0) return null
	return <span className={"m3-badge" + (props.className ? " " + props.className : "")}>{props.count > 99 ? "99+" : props.count}</span>
}

export function Divider() {
	return <div className="m3-divider" role="separator" />
}
