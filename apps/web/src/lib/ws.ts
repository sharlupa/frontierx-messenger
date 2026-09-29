import type { WsEvent } from "./types"
import { watchActivity } from "./activity"

export type RealtimeHandle = {
	close: () => void
	// Native layer's word on whether the app is in front (Android).
	setPresence: (visible: boolean) => void
}

function wsBase(): string {
	const configured = import.meta.env.VITE_WS_BASE as string | undefined
	if (configured) return configured
	const proto = location.protocol === "https:" ? "wss:" : "ws:"
	return proto + "//" + location.host
}

// `quiet` connections (background accounts) never show their user as online.
export function connectRealtime(token: string, onEvent: (event: WsEvent) => void, options: { quiet?: boolean } = {}): RealtimeHandle {
	let closed = false
	let retry = 0
	let socket: WebSocket | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	// Presence state the current socket was opened with (or last told).
	let announced = true

	// Others see this user online only while they are looking at FrontierX.
	// A change is sent over the open socket; no reconnect, so calls and
	// realtime delivery are not interrupted by switching tabs.
	const activity = watchActivity((active) => announce(active))

	function announce(active: boolean) {
		if (options.quiet) return
		if (!socket || socket.readyState !== WebSocket.OPEN) return
		if (announced === active) return
		announced = active
		try {
			socket.send(JSON.stringify({ type: "presence", active }))
		} catch {
			// The socket is going away; the next one starts with the right state.
		}
	}

	function open() {
		if (closed) return
		announced = options.quiet ? false : activity.active()
		const url = wsBase() + "/ws?token=" + encodeURIComponent(token) + (announced ? "" : "&presence=0")
		socket = new WebSocket(url)

		socket.onopen = () => {
			retry = 0
			// The state may have changed while the socket was connecting.
			announce(activity.active())
		}

		socket.onmessage = (ev) => {
			try {
				const parsed = JSON.parse(ev.data as string) as WsEvent
				onEvent(parsed)
			} catch {
				// ignore malformed frames
			}
		}

		socket.onclose = () => {
			socket = null
			if (closed) return
			const delay = Math.min(30000, 500 * 2 ** Math.min(retry, 6))
			retry += 1
			timer = setTimeout(open, delay)
		}

		socket.onerror = () => {
			if (socket) socket.close()
		}
	}

	const setNative = (visible: boolean) => activity.setNativeInFront(visible)
	if (!options.quiet) (window as unknown as { fxSetPresence?: (v: boolean) => void }).fxSetPresence = setNative

	open()

	return {
		setPresence: setNative,
		close() {
			closed = true
			activity.stop()
			if (!options.quiet) (window as unknown as { fxSetPresence?: (v: boolean) => void }).fxSetPresence = undefined
			if (timer) clearTimeout(timer)
			if (socket) socket.close()
		},
	}
}
