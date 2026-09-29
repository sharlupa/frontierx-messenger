import { useRef } from "react"
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react"

// Right click with a mouse, or holding a finger on a phone: both open the same
// small menu at that spot. Handlers go on the element that has the menu (or on
// a list: `open` gets the element under the pointer and returns false when
// there is nothing there to open a menu for).
export function useContextMenuGesture(open: (x: number, y: number, target: HTMLElement | null) => boolean | void, holdMs = 450) {
	const timer = useRef<number | null>(null)
	const start = useRef<{ x: number; y: number } | null>(null)
	const openedAt = useRef(0)

	const cancel = () => {
		if (timer.current !== null) window.clearTimeout(timer.current)
		timer.current = null
		start.current = null
	}
	const fire = (x: number, y: number, target: HTMLElement | null): boolean => {
		const handled = open(x, y, target) !== false
		if (handled) openedAt.current = Date.now()
		return handled
	}

	return {
		onContextMenu: (event: ReactMouseEvent) => {
			cancel()
			// A long touch fires contextmenu too; the menu is already open.
			if (Date.now() - openedAt.current < 800) {
				event.preventDefault()
				return
			}
			if (fire(event.clientX, event.clientY, event.target as HTMLElement | null)) {
				event.preventDefault()
				event.stopPropagation()
			}
		},
		onPointerDown: (event: ReactPointerEvent) => {
			if (event.pointerType === "mouse") return
			cancel()
			start.current = { x: event.clientX, y: event.clientY }
			const { clientX, clientY } = event
			const target = event.target as HTMLElement | null
			timer.current = window.setTimeout(() => {
				timer.current = null
				if (fire(clientX, clientY, target)) {
					try {
						navigator.vibrate?.(12)
					} catch {
						// no vibration here
					}
				}
			}, holdMs)
		},
		onPointerMove: (event: ReactPointerEvent) => {
			if (!start.current) return
			if (Math.abs(event.clientX - start.current.x) > 10 || Math.abs(event.clientY - start.current.y) > 10) cancel()
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		// The tap that ended a long press must not also press what is under it.
		onClickCapture: (event: ReactMouseEvent) => {
			if (Date.now() - openedAt.current < 600) {
				event.preventDefault()
				event.stopPropagation()
			}
		},
	}
}
