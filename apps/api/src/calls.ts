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

export interface CallState {
  callId: string
  conversationId: string
  media: CallMedia
  startedBy: string
  startedAt: string
  participants: string[]
}

interface ActiveCall {
  callId: string
  conversationId: string
  media: CallMedia
  startedBy: string
  startedAt: string
  participants: Set<string>
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

  // Join the conversation's active call, creating one if none exists. Returns
  // the resulting roster, whether the call was newly created (ring the rest of
  // the conversation), and whether the user was already connected.
  join(conversationId: string, userId: string, media: CallMedia, newCallId: string, now: string): JoinResult {
    let call = this.byConversation.get(conversationId)
    let created = false
    if (!call) {
      call = { callId: newCallId, conversationId, media, startedBy: userId, startedAt: now, participants: new Set<string>() }
      this.byConversation.set(conversationId, call)
      created = true
    }
    const alreadyIn = call.participants.has(userId)
    call.participants.add(userId)
    return { state: snapshot(call), created, alreadyIn }
  }

  // Remove a user from the conversation's call. When the last participant
  // leaves, the call is deleted and ended === true.
  leave(conversationId: string, userId: string): LeaveResult {
    const call = this.byConversation.get(conversationId)
    if (!call) return { state: null, removed: false, ended: false, callId: null }
    const removed = call.participants.delete(userId)
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
