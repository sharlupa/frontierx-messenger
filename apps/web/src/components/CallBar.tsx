import { createElement, useCallback, useEffect, useRef, useState } from "react"
import type { RemoteAudio } from "../lib/useCall"
import { useSettings } from "../state/settings"
import { startLevelMeter } from "../lib/voice"
import { ensureAudioContext } from "../lib/sound"

function ScreenVideo(props: { stream: MediaStream; muted: boolean; label: string; fsLabel: string }) {
	const ref = useRef(null as HTMLVideoElement | null)
	const boxRef = useRef(null as HTMLDivElement | null)
	useEffect(() => {
		const el = ref.current
		if (!el) return
		el.srcObject = props.stream
		const kick = () => { void el.play().catch(() => undefined) }
		kick()
		el.addEventListener('loadedmetadata', kick)
		el.addEventListener('canplay', kick)
		// A remote screen track can arrive before real frames do, which leaves the
		// element paused on a black frame, so keep nudging playback.
		const timer = setInterval(() => { if (el.paused) kick() }, 1200)
		return () => {
			clearInterval(timer)
			el.removeEventListener('loadedmetadata', kick)
			el.removeEventListener('canplay', kick)
			el.srcObject = null
		}
	}, [props.stream])
	const toggleFullscreen = useCallback(() => {
		const box: any = boxRef.current
		const doc: any = document
		if (!box) return
		if (doc.fullscreenElement || doc.webkitFullscreenElement) {
			if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined)
			else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen()
			return
		}
		if (box.requestFullscreen) void box.requestFullscreen().catch(() => undefined)
		else if (box.webkitRequestFullscreen) box.webkitRequestFullscreen()
	}, [])
	return createElement(
		'div',
		{ className: 'call-screen', ref: boxRef },
		createElement('video', { ref, className: 'call-screen-video', autoPlay: true, playsInline: true, muted: props.muted, onDoubleClick: toggleFullscreen }),
		createElement('span', { className: 'call-screen-label' }, props.label),
		createElement('button', { type: 'button', className: 'button ghost small call-screen-fs', onClick: toggleFullscreen }, props.fsLabel),
	)
}
function RemoteAudioTrack({
	stream,
	peerId,
	audioMap,
	onBlocked,
}: {
	stream: MediaStream
	peerId: string
	audioMap: Map<string, HTMLAudioElement>
	onBlocked: () => void
}) {
	const ref = useRef<HTMLAudioElement | null>(null)
	useEffect(() => {
		const el = ref.current
		if (!el) return
		el.srcObject = stream
		el.muted = false
		el.volume = 1
		audioMap.set(peerId, el)
		const played = el.play()
		if (played && typeof played.catch === "function") {
			played.catch(() => onBlocked())
		}
		return () => {
			audioMap.delete(peerId)
			el.srcObject = null
		}
	}, [stream, peerId, audioMap, onBlocked])
	return <audio ref={ref} autoPlay playsInline />
}

// Same bar count as the composer meter, so the two look alike.
const METER_BARS = 18

function MicMeter({ stream, muted }: { stream: MediaStream | null; muted: boolean }) {
	const [levels, setLevels] = useState<number[]>([])
	const [live, setLive] = useState(false)
	useEffect(() => {
		if (!stream) {
			setLive(false)
			setLevels([])
			return
		}
		const track = stream.getAudioTracks()[0] ?? null
		setLive(Boolean(track && track.readyState === "live"))
		// The same meter the composer uses while recording a voice message, on
		// the AudioContext the call already unlocked when it started.
		const stop = startLevelMeter(stream, (level) => {
			setLevels((prev) => prev.concat([level]).slice(-METER_BARS))
		}, { context: ensureAudioContext() })
		return () => {
			stop()
			setLevels([])
		}
	}, [stream])
	return (
		<span className={"mic-indicator" + (live && !muted ? " live" : "") + (muted ? " muted" : "")}>
			<span className="mic-indicator-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
					<rect x="9" y="3" width="6" height="11" rx="3" />
					<path d="M5 11a7 7 0 0 0 14 0" />
					<line x1="12" y1="18" x2="12" y2="22" />
				</svg>
			</span>
			<span className="mic-meter" aria-hidden="true">
				{Array.from({ length: METER_BARS }).map((_unused, index) => {
					const level = muted ? 0 : levels[levels.length - METER_BARS + index]
					const height = Math.max(3, Math.round(((level ?? 0) / 100) * 18))
					return <span key={index} className="mic-meter-bar" style={{ height: height + "px" }} />
				})}
			</span>
		</span>
	)
}

export function CallBar(props: {
	participantCount: number
	muted: boolean
	remotes: RemoteAudio[]
	localStream: MediaStream | null
	onToggleMute: () => void
	sharing: boolean
	screenStream: MediaStream | null
	remoteScreens: RemoteAudio[]
	onToggleShare: () => void
	onLeave: () => void
}) {
	const { t } = useSettings()
	const [blocked, setBlocked] = useState(false)
	const audioMapRef = useRef<Map<string, HTMLAudioElement>>(new Map())
	const audioMap = audioMapRef.current
	const onBlocked = useCallback(() => setBlocked(true), [])
	const enableSound = useCallback(() => {
		audioMap.forEach((el) => {
			void el.play().catch(() => undefined)
		})
		setBlocked(false)
	}, [audioMap])

	useEffect(() => {
		const resume = () => {
			audioMap.forEach((el) => {
				void el.play().catch(() => undefined)
			})
			setBlocked(false)
		}
		// Remote audio elements mount after the join gesture, so their first
		// play() may be blocked or resolve muted. Keep unlock listeners armed for
		// the whole call and re-run when a remote arrives, so the next user
		// interaction (re)plays every remote track.
		document.addEventListener("click", resume)
		document.addEventListener("keydown", resume)
		document.addEventListener("touchstart", resume)
		return () => {
			document.removeEventListener("click", resume)
			document.removeEventListener("keydown", resume)
			document.removeEventListener("touchstart", resume)
		}
	}, [audioMap, props.remotes.length])

	const shareBtn = createElement("button", { type: "button", className: "button ghost small", onClick: props.onToggleShare }, props.sharing ? t("stopShare") : t("shareScreen"))
	const screenNodes: any[] = []
	if (props.screenStream) screenNodes.push(createElement(ScreenVideo, { key: "local", stream: props.screenStream, muted: true, label: t('yourScreen'), fsLabel: t('fullscreen') }))
	props.remoteScreens.forEach((entry) => screenNodes.push(createElement(ScreenVideo, { key: entry.peerId, stream: entry.stream, muted: false, label: t('sharedScreen'), fsLabel: t('fullscreen') })))
	const screensNode = screenNodes.length ? createElement("div", { className: "call-screens" }, screenNodes) : null

	return (
		<div className="call-bar" role="region" aria-label={t("voiceCall")}>
			<div className="call-bar-info">
				<span className="call-bar-dot" aria-hidden="true" />
				<span className="call-bar-label">{t("voiceCall")}</span>
				<span className="call-bar-count">{props.participantCount} {t("inCall")}</span>
				{props.remotes.length === 0 ? <span className="call-bar-wait">{t("waitingForOthers")}</span> : null}
			</div>
			<div className="call-bar-mic">
				<span className="call-bar-mic-label">{props.muted ? t("muted") : t("yourMic")}</span>
				<MicMeter stream={props.localStream} muted={props.muted} />
			</div>
			<div className="call-bar-actions">
				{blocked ? (
					<button type="button" className="button small primary" onClick={enableSound}>
						{t("enableSound")}
					</button>
				) : null}
			{shareBtn}
				<button type="button" className="button ghost small" onClick={props.onToggleMute}>
					{props.muted ? t("unmute") : t("mute")}
				</button>
				<button type="button" className="button small call-leave" onClick={props.onLeave}>
					{t("leave")}
				</button>
			</div>
		{screensNode}
			<div className="call-audio-sink" aria-hidden="true">
				{props.remotes.map((remote) => (
					<RemoteAudioTrack
						key={remote.peerId}
						peerId={remote.peerId}
						stream={remote.stream}
						audioMap={audioMap}
						onBlocked={onBlocked}
					/>
				))}
			</div>
		</div>
	)
}

export function IncomingCallBanner(props: { label: string; onAccept: () => void; onDismiss: () => void }) {
	const { t } = useSettings()
	return (
		<div className="call-incoming" role="alertdialog" aria-label={t("incomingCall")}>
			<div className="call-incoming-text">
				<strong>{t("incomingCall")}</strong>
				<span>{props.label}</span>
			</div>
			<div className="call-incoming-actions">
				<button type="button" className="button primary small" onClick={props.onAccept}>
					{t("join")}
				</button>
				<button type="button" className="button ghost small" onClick={props.onDismiss}>
					{t("dismiss")}
				</button>
			</div>
		</div>
	)
}