// In-memory registry of active voice calls, plus WebRTC ICE configuration.
//
// A "call" is ephemeral group state scoped to a single conversation: the set of
// members currently connected. The server never touches audio media - it only
// relays WebRTC signaling (SDP offers/answers and ICE candidates) between
// members over the existing WebSocket event bus. Keeping the server a thin
// signaling relay is what makes group voice calls affordable on a single-core
// VPS.
//
// State is intentionally not persisted: a process restart ends any in-flight
// calls, which is the correct behavior for real-time sessions.

export type CallMedia = "audio"

// A participant whose last connection drops keeps their place in the call for
// this long. Phones switch networks and browsers reconnect their socket; the
// audio itself flows peer to peer and usually survives the blip, so leaving at
// once would cut a call that is still working. CALL_RECONNECT_GRACE_MS
// overrides it (0 leaves at once).
export const CALL_RECONNECT_GRACE_MS = envMs("CALL_RECONNECT_GRACE_MS", 15000)

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export interface CallState {
  callId: string
  conversationId: string
  media: CallMedia
  startedBy: string
  startedAt: string
  participants: string[]
  // Participants who turned their microphone off.
  muted: string[]
}

interface ActiveCall {
  callId: string
  conversationId: string
  media: CallMedia
  startedBy: string
  startedAt: string
  participants: Set<string>
  muted: Set<string>
}

export interface JoinResult {
  state: CallState
  created: boolean
  alreadyIn: boolean
}

export interface LeaveResult {
  state: CallState | null
  removed: boolean
  ended: boolean
  callId: string | null
}

// Registry of at most one active call per conversation. All methods are
// synchronous and side-effect free beyond the in-memory map, so route handlers
// can compute the resulting fan-out from the returned state.
export class CallRegistry {
  private byConversation = new Map<string, ActiveCall>()

  get(conversationId: string): CallState | null {
    const call = this.byConversation.get(conversationId)
    return call ? snapshot(call) : null
  }

  isParticipant(conversationId: string, userId: string): boolean {
    return this.byConversation.get(conversationId)?.participants.has(userId) ?? false
  }

  isInAnyCall(userId: string): boolean {
    for (const call of this.byConversation.values()) if (call.participants.has(userId)) return true
    return false
  }

  // Join the conversation's active call, creating one if none exists. Returns
  // the resulting roster, whether the call was newly created (ring the rest of
  // the conversation), and whether the user was already connected.
  join(conversationId: string, userId: string, media: CallMedia, newCallId: string, now: string): JoinResult {
    let call = this.byConversation.get(conversationId)
    let created = false
    if (!call) {
      call = { callId: newCallId, conversationId, media, startedBy: userId, startedAt: now, participants: new Set<string>(), muted: new Set<string>() }
      this.byConversation.set(conversationId, call)
      created = true
    }
    const alreadyIn = call.participants.has(userId)
    call.participants.add(userId)
    // Everyone (re)joins with the microphone on, as the client starts it.
    if (!alreadyIn) call.muted.delete(userId)
    return { state: snapshot(call), created, alreadyIn }
  }

  // A participant turned the microphone off or on. Null when the user is not
  // in this conversation's call.
  setMuted(conversationId: string, userId: string, muted: boolean): CallState | null {
    const call = this.byConversation.get(conversationId)
    if (!call || !call.participants.has(userId)) return null
    if (muted) call.muted.add(userId)
    else call.muted.delete(userId)
    return snapshot(call)
  }

  // Remove a user from the conversation's call. When the last participant
  // leaves, the call is deleted and ended === true.
  leave(conversationId: string, userId: string): LeaveResult {
    const call = this.byConversation.get(conversationId)
    if (!call) return { state: null, removed: false, ended: false, callId: null }
    const removed = call.participants.delete(userId)
    call.muted.delete(userId)
    const callId = call.callId
    if (call.participants.size === 0) {
      this.byConversation.delete(conversationId)
      return { state: null, removed, ended: true, callId }
    }
    return { state: snapshot(call), removed, ended: false, callId }
  }

  // Remove a user from every call they are in. Used when a socket disconnects
  // so a dropped participant does not linger in the roster.
  leaveAll(userId: string): Array<{ conversationId: string; state: CallState | null; ended: boolean; callId: string }> {
    const affected: Array<{ conversationId: string; state: CallState | null; ended: boolean; callId: string }> = []
    for (const conversationId of [...this.byConversation.keys()]) {
      const call = this.byConversation.get(conversationId)
      if (!call || !call.participants.has(userId)) continue
      const res = this.leave(conversationId, userId)
      affected.push({ conversationId, state: res.state, ended: res.ended, callId: res.callId as string })
    }
    return affected
  }
}

function snapshot(call: ActiveCall): CallState {
  return {
    callId: call.callId,
    conversationId: call.conversationId,
    media: call.media,
    startedBy: call.startedBy,
    startedAt: call.startedAt,
    participants: [...call.participants],
    muted: [...call.muted],
  }
}

// ICE servers for the browser RTCPeerConnection. Empty by default: on localhost
// or a LAN, host candidates connect directly with no external dependency, which
// keeps the default privacy-preserving. For calls across the public internet,
// set ICE_SERVERS to a JSON array of RTCIceServer objects, for example:
//   ICE_SERVERS='[{"urls":"stun:stun.l.example.org:3478"},{"urls":"turn:turn.example.org:3478","username":"u","credential":"p"}]'
export function iceServersFromEnv(): Array<Record<string, unknown>> {
  const raw = process.env.ICE_SERVERS
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
    } catch {
      // fall through to the built-in defaults below
    }
  }
  // Sensible defaults so calls connect across the public internet with no
  // configuration: STUN for direct paths, plus a public TURN relay for peers
  // behind strict / mobile-carrier NATs. Override with ICE_SERVERS (a JSON
  // array of RTCIceServer objects) to use a private, production-grade TURN.
  return [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    {
      urls: ["turn:staticauth.openrelay.metered.ca:80", "turn:staticauth.openrelay.metered.ca:443", "turns:staticauth.openrelay.metered.ca:443"],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ]
}
