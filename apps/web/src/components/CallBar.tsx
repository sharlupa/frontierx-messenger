import { createElement, useCallback, useEffect, useRef, useState } from "react"
import type { RemoteAudio } from "../lib/useCall"
import { useSettings } from "../state/settings"
import { startLevelMeter } from "../lib/voice"
import { ensureAudioContext } from "../lib/sound"
import { Avatar, Button, ShapeIcon } from "./m3"
import { IChevronRight, IExpand, IMic, IMicOff, IMinimize, IPhoneCall, IScreenShare } from "./m3icons"

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
	onBlocked: (blocked: boolean) => void
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
			played.catch(() => onBlocked(true))
		}
		return () => {
			audioMap.delete(peerId)
			el.srcObject = null
		}
	}, [stream, peerId, audioMap, onBlocked])
	return <audio ref={ref} autoPlay playsInline />
}

// The others' voices. Mounted for the whole call, whichever chat is open, so
// moving to another chat never silences it. A browser may refuse to start the
// sound before the person interacts with the page; the next click, key or
// touch anywhere starts every voice again.
export function CallAudio(props: { remotes: RemoteAudio[]; onBlockedChange: (blocked: boolean) => void }) {
	const audioMapRef = useRef<Map<string, HTMLAudioElement>>(new Map())
	const audioMap = audioMapRef.current
	const { onBlockedChange } = props
	useEffect(() => {
		const resume = () => {
			audioMap.forEach((el) => {
				void el.play().catch(() => undefined)
			})
			onBlockedChange(false)
		}
		document.addEventListener("click", resume)
		document.addEventListener("keydown", resume)
		document.addEventListener("touchstart", resume)
		return () => {
			document.removeEventListener("click", resume)
			document.removeEventListener("keydown", resume)
			document.removeEventListener("touchstart", resume)
		}
	}, [audioMap, onBlockedChange, props.remotes.length])
	return (
		<div className="call-audio-sink" aria-hidden="true">
			{props.remotes.map((remote) => (
				<RemoteAudioTrack key={remote.peerId} peerId={remote.peerId} stream={remote.stream} audioMap={audioMap} onBlocked={onBlockedChange} />
			))}
		</div>
	)
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

// Someone else in the call, with whether their microphone is on.
export type CallPerson = { id: string; name: string; avatar: string | null; muted: boolean }

// The other person's microphone, under their picture: on, or crossed out.
function PeerMic(props: { person: CallPerson; size?: "s" | "m" }) {
	const { t } = useSettings()
	const label = (props.person.muted ? t("callPeerMicOff") : t("callPeerMicOn")) + ": " + props.person.name
	return (
		<span className={"call-peer-mic" + (props.person.muted ? " off" : "") + (props.size === "s" ? " small" : "")} role="img" aria-label={label} title={label}>
			<span className="call-peer-mic-icon" key={props.person.muted ? "off" : "on"}>
				{props.person.muted ? <IMicOff size={props.size === "s" ? 12 : 16} /> : <IMic size={props.size === "s" ? 12 : 16} />}
			</span>
		</span>
	)
}

export function CallBar(props: {
	participantCount: number
	// The others in the call; a one-to-one call has one.
	people: CallPerson[]
	direct: boolean
	muted: boolean
	// How many of the others are connected (their voice arrives).
	connectedCount: number
	localStream: MediaStream | null
	onToggleMute: () => void
	sharing: boolean
	screenStream: MediaStream | null
	remoteScreens: RemoteAudio[]
	onToggleShare: () => void
	onLeave: () => void
	title: string
	avatar?: string | null
	seed?: string
	shape?: "circle" | "group" | "channel"
	// When this device joined; the timer counts from here.
	joinedAt: number | null
	// Why the microphone is not working, if it is not.
	micNotice?: string | null
	// The browser held the sound back; a click anywhere starts it (CallAudio).
	soundBlocked: boolean
	// The call belongs to another chat than the open one: a slim bar that
	// leads back to it.
	onReturn?: () => void
}) {
	const { t } = useSettings()
	const blocked = props.soundBlocked

	const screenNodes: any[] = []
	if (props.screenStream) screenNodes.push(createElement(ScreenVideo, { key: "local", stream: props.screenStream, muted: true, label: t('yourScreen'), fsLabel: t('fullscreen') }))
	props.remoteScreens.forEach((entry) => screenNodes.push(createElement(ScreenVideo, { key: entry.peerId, stream: entry.stream, muted: false, label: t('sharedScreen'), fsLabel: t('fullscreen') })))
	const screensNode = screenNodes.length ? createElement("div", { className: "call-screens" }, screenNodes) : null

	const [collapsedHere, setCollapsed] = useState(false)
	const collapsed = collapsedHere || Boolean(props.onReturn)
	const elapsed = useElapsed(props.joinedAt)
	const waiting = props.connectedCount === 0
	const status = waiting ? t("callWaiting") : props.participantCount > 2 ? elapsed + " · " + props.participantCount + " " + t("inCall") : elapsed
	// The sound button is a plain button: the click itself is what lets
	// CallAudio start the voices.
	const soundButton = blocked ? <button type="button" className="call-sound-btn">{t("enableSound")}</button> : null
	const micNotice = props.micNotice ? <p className="call-mic-notice" role="status"><IMicOff size={16} /><span>{props.micNotice}</span></p> : null
	const muteButton = (small: boolean) => (
		<button type="button" className={"call-btn" + (small ? " small" : "") + (props.muted ? " off" : "")} onClick={props.onToggleMute} aria-pressed={props.muted} aria-label={props.muted ? t("unmute") : t("mute")} title={props.muted ? t("unmute") : t("mute")}>
			{props.muted ? <IMicOff size={small ? 18 : 24} /> : <IMic size={small ? 18 : 24} />}
		</button>
	)
	const endButton = (small: boolean) => (
		<button type="button" className={"call-btn end" + (small ? " small" : "")} onClick={props.onLeave} aria-label={t("leave")} title={t("leave")}>
			<IPhoneCall size={small ? 18 : 24} className="call-end-icon" />
		</button>
	)

	if (collapsed) {
		const returning = Boolean(props.onReturn)
		return (
			<div className={"call-mini" + (returning ? " elsewhere" : "")} role="region" aria-label={t("voiceCall")}>
				<button type="button" className="call-mini-main" onClick={() => (props.onReturn ? props.onReturn() : setCollapsed(false))} aria-label={returning ? t("callReturn") : t("callExpand")} title={returning ? t("callReturn") : undefined}>
					<Avatar src={props.avatar} label={props.title} seed={props.seed} size={32} shape={props.shape} />
					<span className="call-mini-text">
						<span className="call-mini-title">{props.title}</span>
						<span className="call-mini-status">
							<span className={"call-live-dot" + (waiting ? " waiting" : "")} aria-hidden="true" />
							{status}
							{props.people.some((person) => person.muted) ? <span className="call-mini-muted" title={t("callPeerMicOff")} aria-label={t("callPeerMicOff")}><IMicOff size={13} /></span> : null}
						</span>
					</span>
					{returning ? <IChevronRight size={18} /> : <IExpand size={18} />}
				</button>
				{soundButton}
				{muteButton(true)}
				{endButton(true)}
				{returning ? null : screensNode}
				{micNotice}
			</div>
		)
	}

	return (
		<div className={"call-card" + (waiting ? " waiting" : " live")} role="region" aria-label={t("voiceCall")}>
			<button type="button" className="call-collapse" onClick={() => setCollapsed(true)} aria-label={t("callMinimize")} title={t("callMinimize")}>
				<IMinimize size={18} />
			</button>
			<div className="call-av-wrap">
				<span className="call-ring" aria-hidden="true" />
				<span className="call-ring second" aria-hidden="true" />
				<Avatar src={props.avatar} label={props.title} seed={props.seed} size={104} shape={props.shape} className="call-av-img" />
				{props.direct && props.people[0] ? <PeerMic person={props.people[0]} /> : null}
			</div>
			<div className="call-card-text">
				<div className="call-card-title">{props.title}</div>
				<div className="call-card-status">{status}</div>
			</div>
			{!props.direct && props.people.length > 0 ? (
				<ul className="call-people" aria-label={t("inCall")}>
					{props.people.map((person) => (
						<li key={person.id} className="call-person" title={person.name}>
							<span className="call-person-av">
								<Avatar src={person.avatar} label={person.name} seed={person.id} size={40} />
								<PeerMic person={person} size="s" />
							</span>
							<span className="call-person-name">{person.name}</span>
						</li>
					))}
				</ul>
			) : null}
			<MicMeter stream={props.localStream} muted={props.muted} />
			{micNotice}
			{soundButton}
			<div className="call-card-actions">
				{muteButton(false)}
				<button type="button" className={"call-btn" + (props.sharing ? " on" : "")} onClick={props.onToggleShare} aria-pressed={props.sharing} aria-label={props.sharing ? t("stopShare") : t("shareScreen")} title={props.sharing ? t("stopShare") : t("shareScreen")}>
					<IScreenShare size={24} />
				</button>
				{endButton(false)}
			</div>
			{screensNode}
		</div>
	)
}

// mm:ss (h:mm:ss after an hour) since joining the call.
function useElapsed(since: number | null): string {
	const [mountedAt] = useState(() => Date.now())
	const started = since ?? mountedAt
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [])
	const total = Math.max(0, Math.floor((now - started) / 1000))
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const sec = String(total % 60).padStart(2, "0")
	return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec
}

export function IncomingCallBanner(props: { label: string; onAccept: () => void; onDismiss: () => void; avatar?: string | null; seed?: string }) {
	const { t } = useSettings()
	return (
		<div className="call-incoming" role="alertdialog" aria-label={t("incomingCall")}>
			<div className="call-incoming-av">
				<span className="call-ring" aria-hidden="true" />
				<Avatar src={props.avatar} label={props.label} seed={props.seed} size={48} />
			</div>
			<div className="call-incoming-text">
				<strong>{props.label}</strong>
				<span>{t("incomingCall")}</span>
			</div>
			<div className="call-incoming-actions">
				<button type="button" className="call-btn small end" onClick={props.onDismiss} aria-label={t("dismiss")} title={t("dismiss")}>
					<IPhoneCall size={18} className="call-end-icon" />
				</button>
				<button type="button" className="call-btn small accept" onClick={props.onAccept} aria-label={t("join")} title={t("join")}>
					<IPhoneCall size={18} />
				</button>
			</div>
		</div>
	)
}

// A call is going on in the open chat and this device is not in it.
export function OngoingCallBar(props: { count: number; busy: boolean; onJoin: () => void }) {
	const { t } = useSettings()
	return (
		<div className="call-ongoing" role="status">
			<ShapeIcon icon={<IPhoneCall size={18} />} shape="circle" tone="green" size={40} />
			<span className="call-ongoing-text">
				<span className="call-ongoing-title">{t("callOngoing")}</span>
				<span className="call-ongoing-count">{props.count} {t("inCall")}</span>
			</span>
			<Button variant="filled" disabled={props.busy} onClick={props.onJoin}>{t("join")}</Button>
		</div>
	)
}
