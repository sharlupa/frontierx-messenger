// Browser-side WebRTC voice call session.
//
// The server is only a signaling relay and never sees audio. Group calls use a
// full mesh (one RTCPeerConnection per remote peer). Audio only.
//
// Reliability: the peer with the smaller user id creates the offer (decided in
// useCall), so exactly one side offers per pair and there is no glare. If a
// connection drops or fails, the offering side automatically renegotiates with
// an ICE restart. ICE uses STUN plus a public TURN relay by default so audio
// still flows when peers are behind strict/mobile NATs; override on the API
// with the ICE_SERVERS env for a private TURN.

export type SignalData =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "candidate"; candidate: RTCIceCandidateInit }

export interface CallSessionOptions {
  iceServers: RTCIceServer[]
  sendSignal: (to: string, data: SignalData) => void
  onRemoteStream: (peerId: string, stream: MediaStream) => void
  onPeerRemoved: (peerId: string) => void
  onRemoteScreen?: (peerId: string, stream: MediaStream | null) => void
  onShareEnded?: () => void
  onPeerState?: (peerId: string, state: RTCPeerConnectionState) => void
}

interface PeerEntry {
  pc: RTCPeerConnection
  remoteSet: boolean
  isOfferer: boolean
  pendingCandidates: RTCIceCandidateInit[]
  videoSender: RTCRtpSender | null
  renegotiateQueued: number
  restartTimer: ReturnType<typeof setTimeout> | null
}

// STUN discovers the public address; TURN relays media when a direct path is
// impossible (symmetric / mobile-carrier NAT). The public openrelay project is
// a best-effort zero-config default so calls work out of the box. For reliable
// production calls, run your own coturn and set ICE_SERVERS on the API.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  {
    urls: ["turn:staticauth.openrelay.metered.ca:80", "turn:staticauth.openrelay.metered.ca:443", "turns:staticauth.openrelay.metered.ca:443"],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
]

export class CallSession {
  private peers = new Map<string, PeerEntry>()
  private localStream: MediaStream | null = null
  private muted = false
  private screenStream: MediaStream | null = null
  private screenTrack: MediaStreamTrack | null = null
  private stopped = false

  constructor(private readonly opts: CallSessionOptions) {}

  async start(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      this.applyMute()
    }
    return this.localStream
  }

  getLocalStream(): MediaStream | null {
    return this.localStream
  }

  private iceServersConfig(): RTCIceServer[] {
    return this.opts.iceServers && this.opts.iceServers.length > 0 ? this.opts.iceServers : DEFAULT_ICE_SERVERS
  }

  private createPeer(peerId: string, isOfferer: boolean): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: this.iceServersConfig(), bundlePolicy: "max-bundle" })
    const entry: PeerEntry = { pc, remoteSet: false, isOfferer, pendingCandidates: [], restartTimer: null, videoSender: null, renegotiateQueued: 0 }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream)
    }
    try {
      const vt = pc.addTransceiver("video", { direction: "sendrecv" })
      entry.videoSender = vt.sender
      if (this.screenTrack) void vt.sender.replaceTrack(this.screenTrack)
      void this.tuneSender(vt.sender)
    } catch {
      entry.videoSender = null
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) this.opts.sendSignal(peerId, { kind: "candidate", candidate: event.candidate.toJSON() })
    }
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      if (event.track.kind === "video") {
        // The video transceiver exists from the first negotiation, so the remote
        // track arrives muted and frameless until the peer really shares. Only
        // surface it once frames flow, otherwise every call shows a black tile.
        const publish = () => this.opts.onRemoteScreen?.(peerId, stream)
        const clear = () => this.opts.onRemoteScreen?.(peerId, null)
        if (!event.track.muted) publish()
        event.track.onunmute = publish
        event.track.onmute = clear
        event.track.onended = clear
        return
      }
      this.opts.onRemoteStream(peerId, stream)
    }
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      this.opts.onPeerState?.(peerId, state)
      if (state === "connected") {
        this.clearRestart(peerId)
      } else if (state === "failed") {
        this.scheduleRestart(peerId, 0)
      } else if (state === "disconnected") {
        this.scheduleRestart(peerId, 2500)
      }
    }
    this.peers.set(peerId, entry)
    return entry
  }

  // Screen sharing changes what a peer sends, so the pair must renegotiate:
  // replaceTrack alone never reaches the other side. After the first exchange
  // both sides are stable, so either of them may offer. If a negotiation is
  // already in flight, retry shortly instead of dropping the change.
  private async renegotiate(peerId: string) {
    const entry = this.peers.get(peerId)
    if (!entry || this.stopped) return
    if (entry.pc.signalingState !== "stable") {
      if (entry.renegotiateQueued > 6) return
      entry.renegotiateQueued += 1
      setTimeout(() => void this.renegotiate(peerId), 900)
      return
    }
    entry.renegotiateQueued = 0
    await this.sendOffer(peerId, false)
  }
  private clearRestart(peerId: string): void {
    const entry = this.peers.get(peerId)
    if (entry && entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }
  }

  // Only the offering side re-offers, so the ICE restart stays glare-free.
  private scheduleRestart(peerId: string, delay: number): void {
    const entry = this.peers.get(peerId)
    if (!entry || this.stopped || !entry.isOfferer || entry.restartTimer) return
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null
      if (this.peers.get(peerId)?.pc.connectionState === "connected") return
      void this.sendOffer(peerId, true)
    }, delay)
  }

  async offerTo(peerId: string): Promise<void> {
    if (this.stopped || this.peers.has(peerId)) return
    this.createPeer(peerId, true)
    await this.sendOffer(peerId, false)
  }

  private async sendOffer(peerId: string, iceRestart: boolean): Promise<void> {
    const entry = this.peers.get(peerId)
    if (!entry || this.stopped) return
    try {
      const offer = await entry.pc.createOffer(iceRestart ? { iceRestart: true } : {})
      await entry.pc.setLocalDescription(offer)
      const sdp = entry.pc.localDescription?.sdp
      if (sdp) this.opts.sendSignal(peerId, { kind: "offer", sdp })
    } catch {
      // Transient; the next connection-state change will retry.
    }
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    if (this.stopped) return
    if (data.kind === "offer") {
      const entry = this.peers.get(from) ?? this.createPeer(from, false)
      if (entry.pc.signalingState !== "stable") {
        // Both sides offered at once. Rolling the local offer back and
        // answering theirs keeps our own tracks in the fresh answer.
        try {
          await entry.pc.setLocalDescription({ type: "rollback" })
        } catch {
          return
        }
      }
      await entry.pc.setRemoteDescription({ type: "offer", sdp: data.sdp })
      entry.remoteSet = true
      await this.flushCandidates(from)
      const answer = await entry.pc.createAnswer()
      await entry.pc.setLocalDescription(answer)
      const sdp = entry.pc.localDescription?.sdp
      if (sdp) this.opts.sendSignal(from, { kind: "answer", sdp })
      return
    }
    if (data.kind === "answer") {
      const entry = this.peers.get(from)
      if (!entry) return
      if (entry.pc.signalingState !== "have-local-offer") return
      await entry.pc.setRemoteDescription({ type: "answer", sdp: data.sdp })
      entry.remoteSet = true
      await this.flushCandidates(from)
      return
    }
    const entry = this.peers.get(from)
    if (!entry) return
    if (!entry.remoteSet) {
      entry.pendingCandidates.push(data.candidate)
      return
    }
    try {
      await entry.pc.addIceCandidate(data.candidate)
    } catch {
      // A rejected candidate is not fatal; other pairs may still connect.
    }
  }

  private async flushCandidates(peerId: string): Promise<void> {
    const entry = this.peers.get(peerId)
    if (!entry) return
    const pending = entry.pendingCandidates
    entry.pendingCandidates = []
    for (const candidate of pending) {
      try {
        await entry.pc.addIceCandidate(candidate)
      } catch {
        // ignore
      }
    }
  }

  removePeer(peerId: string): void {
    const entry = this.peers.get(peerId)
    if (!entry) return
    this.clearRestart(peerId)
    try {
      entry.pc.close()
    } catch {
      // ignore
    }
    this.peers.delete(peerId)
    this.opts.onPeerRemoved(peerId)
  }

  // Close peer connections that are no longer part of the call roster.
  retainPeers(keep: string[]): void {
    const keepSet = new Set(keep)
    for (const peerId of [...this.peers.keys()]) {
      if (!keepSet.has(peerId)) this.removePeer(peerId)
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyMute()
  }

  isMuted(): boolean {
    return this.muted
  }

  private applyMute(): void {
    if (!this.localStream) return
    for (const track of this.localStream.getAudioTracks()) track.enabled = !this.muted
  }

  private async tuneSender(sender: any) {
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      params.encodings[0].maxFramerate = 30
      params.encodings[0].maxBitrate = 2500000
      await sender.setParameters(params)
    } catch {
      // Encoding limits are best effort.
    }
  }

  isSharing() {
    return Boolean(this.screenTrack)
  }

  getScreenStream() {
    return this.screenStream
  }

  async startScreenShare() {
    if (this.screenStream) return this.screenStream
    const media: any = navigator.mediaDevices
    if (!media || !media.getDisplayMedia) return null
    const stream: MediaStream = await media.getDisplayMedia({ video: { cursor: 'always', width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false })
    const track = stream.getVideoTracks()[0] ?? null
    if (!track) return null
    try {
      await track.applyConstraints({ width: 1920, height: 1080, frameRate: 30 })
    } catch {
      // Some sources cannot match 1080p30 exactly.
    }
    this.screenStream = stream
    this.screenTrack = track
    track.onended = () => {
      this.stopScreenShare()
      this.opts.onShareEnded?.()
    }
    for (const [peerId, entry] of this.peers.entries()) {
      if (!entry.videoSender) continue
      try {
        await entry.videoSender.replaceTrack(track)
        await this.tuneSender(entry.videoSender)
        // A video line negotiated before anyone shared can be receive-only.
        const line = entry.pc.getTransceivers().find((item) => item.sender === entry.videoSender)
        if (line && line.direction !== "sendrecv") line.direction = "sendrecv"
        await this.renegotiate(peerId)
        console.info("fx-share sending to " + peerId)
      } catch (err) {
        console.warn("fx-share attach failed", err)
      }
    }
    return stream
  }

  stopScreenShare(): void {
    const track = this.screenTrack
    this.screenTrack = null
    this.screenStream = null
    for (const [peerId, entry] of this.peers.entries()) {
      if (!entry.videoSender) continue
      try {
        void entry.videoSender.replaceTrack(null)
        void this.renegotiate(peerId)
      } catch {
        // ignore
      }
    }
    if (track) {
      track.onended = null
      try {
        track.stop()
      } catch {
        // ignore
      }
    }
  }
  stop(): void {
    this.stopped = true
    this.stopScreenShare()
    for (const entry of this.peers.values()) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer)
      try {
        entry.pc.close()
      } catch {
        // ignore
      }
    }
    const removed = [...this.peers.keys()]
    this.peers.clear()
    for (const peerId of removed) this.opts.onPeerRemoved(peerId)
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop()
      this.localStream = null
    }
  }
}