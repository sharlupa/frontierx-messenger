import { useCallback, useEffect, useRef, useState } from "react"
import type { CallState, WsEvent } from "./types"
import { api } from "./api"
import { CallSession } from "./webrtc"
import type { MicProblem, SignalData } from "./webrtc"
import { errorText } from "./errorText"
import { getActiveLang, translate } from "./i18n"
import { playCallJoinSound, playCallLeaveSound, startRingback, stopRingback } from "./sound"

// How long the roster has to stay put before a join or leave is announced, so
// someone reconnecting (left, then joined again right away) makes no sound.
const ROSTER_SETTLE_MS = 600
// Nobody answering for this long: the ringback falls silent (the call itself
// stays open until it is left).
const RINGBACK_MAX_MS = 60_000

export interface IncomingCall {
  conversationId: string
  callId: string
  from: string
}

export interface RemoteAudio {
  peerId: string
  stream: MediaStream
}

export interface UseCall {
  activeConversationId: string | null
  callId: string | null
  participants: string[]
  muted: boolean
  // Other participants whose microphone is off.
  mutedPeers: string[]
  incoming: IncomingCall | null
  remotes: RemoteAudio[]
  localStream: MediaStream | null
  error: string | null
  // The microphone could not be opened: the call goes on for listening.
  micProblem: MicProblem | null
  // When this device joined the call (for the timer).
  joinedAt: number | null
  // A join is under way.
  joining: boolean
  // Calls going on in the user's chats, by conversation: who is in them.
  ongoing: Record<string, string[]>
  // Joins the chat's call (starting one if there is none), leaving the call
  // of another chat first.
  startOrJoin: (conversationId: string) => Promise<void>
  acceptIncoming: () => void
  leave: () => Promise<void>
  toggleMute: () => void
  sharing: boolean
  screenStream: MediaStream | null
  remoteScreens: RemoteAudio[]
  toggleShare: () => void
  dismissIncoming: () => void
  clearError: () => void
  handleEvent: (event: WsEvent) => void
  // The realtime connection is back: catch up on what was missed meanwhile.
  resync: () => void
  // What the server says about a chat's call (when the chat is opened).
  noteCall: (conversationId: string, call: CallState | null) => void
}

// refusedMessage is the localised wording for a call the other side does not
// accept; the hook itself has no access to the translations.
export function useCall(selfId: string, refusedMessage?: string): UseCall {
  const [callId, setCallId] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [participants, setParticipants] = useState<string[]>([])
  const [muted, setMutedState] = useState(false)
  const [mutedPeers, setMutedPeers] = useState<string[]>([])
  const mutedRef = useRef(false)
  const [incoming, setIncoming] = useState<IncomingCall | null>(null)
  const [remotes, setRemotes] = useState<RemoteAudio[]>([])
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [micProblem, setMicProblem] = useState<MicProblem | null>(null)
  const [joinedAt, setJoinedAt] = useState<number | null>(null)
  const [joining, setJoining] = useState(false)
  const [ongoing, setOngoing] = useState<Record<string, string[]>>({})

  const sessionRef = useRef<CallSession | null>(null)
  const callIdRef = useRef<string | null>(null)
  const conversationIdRef = useRef<string | null>(null)
  const incomingRef = useRef<IncomingCall | null>(null)
  // Bumped whenever the call is left, so a join still on its way notices.
  const generationRef = useRef(0)
  const joiningRef = useRef(false)
  const resyncingRef = useRef(false)
  callIdRef.current = callId
  conversationIdRef.current = conversationId
  incomingRef.current = incoming

  const [sharing, setSharing] = useState(false)
  const [screenStream, setScreenStream] = useState(null as MediaStream | null)
  const [remoteScreens, setRemoteScreens] = useState([] as RemoteAudio[])
  const setRemote = useCallback((peerId: string, stream: MediaStream) => {
    setRemotes((prev) =>
      prev.some((entry) => entry.peerId === peerId)
        ? prev.map((entry) => (entry.peerId === peerId ? { peerId, stream } : entry))
        : prev.concat([{ peerId, stream }]),
    )
  }, [])

  const setRemoteScreen = useCallback((peerId: string, stream: MediaStream | null) => {
    setRemoteScreens((prev) => {
      const rest = prev.filter((entry) => entry.peerId !== peerId)
      return stream ? rest.concat([{ peerId, stream }]) : rest
    })
  }, [])
  const dropRemote = useCallback((peerId: string) => {
    setRemotes((prev) => prev.filter((entry) => entry.peerId !== peerId))
  }, [])

  const participantsRef = useRef<string[]>([])
  participantsRef.current = participants

  // Everyone in the call hears a short sound when someone comes in or leaves,
  // in direct chats and in groups alike. Who was already there when this
  // device joined is not news.
  const announcedRef = useRef<{ callId: string; others: string[] } | null>(null)
  useEffect(() => {
    if (!callId) {
      announcedRef.current = null
      return
    }
    const others = participants.filter((id) => id !== selfId)
    if (announcedRef.current?.callId !== callId) {
      announcedRef.current = { callId, others }
      return
    }
    const timer = window.setTimeout(() => {
      const before = announcedRef.current
      if (!before || before.callId !== callId) return
      announcedRef.current = { callId, others }
      if (others.some((id) => !before.others.includes(id))) playCallJoinSound()
      else if (before.others.some((id) => !others.includes(id))) playCallLeaveSound()
    }, ROSTER_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [callId, participants, selfId])

  // The one calling hears a ringback tone until the first person comes in.
  // Once anyone has been in the call, being alone again is quiet.
  const othersInCall = participants.some((id) => id !== selfId)
  const answeredRef = useRef<string | null>(null)
  if (callId && othersInCall) answeredRef.current = callId
  const waitingForAnswer = callId !== null && !othersInCall && answeredRef.current !== callId
  useEffect(() => {
    if (!waitingForAnswer) return
    startRingback()
    const limit = window.setTimeout(stopRingback, RINGBACK_MAX_MS)
    return () => {
      window.clearTimeout(limit)
      stopRingback()
    }
  }, [waitingForAnswer])

  const noteOngoing = useCallback((cid: string, roster: string[] | null) => {
    setOngoing((prev) => {
      if (!roster || roster.length === 0) {
        if (!(cid in prev)) return prev
        const next = { ...prev }
        delete next[cid]
        return next
      }
      const known = prev[cid]
      if (known && known.length === roster.length && known.every((id, index) => id === roster[index])) return prev
      return { ...prev, [cid]: roster }
    })
  }, [])

  // Reconcile mesh peers against the authoritative participant roster. The peer
  // with the smaller id creates the offer (offerTo is a no-op if the peer
  // already exists), so a single offer happens per pair even if a call.joined
  // event was missed (e.g. the socket reconnected during setup).
  const syncPeers = useCallback((roster: string[]) => {
    const session = sessionRef.current
    if (!session) return
    const others = roster.filter((id) => id !== selfId)
    for (const peerId of others) {
      if (selfId < peerId) void session.offerTo(peerId)
    }
    session.retainPeers(others)
  }, [selfId])

  const teardown = useCallback(() => {
    generationRef.current += 1
    if (sessionRef.current) {
      sessionRef.current.stop()
      sessionRef.current = null
    }
    callIdRef.current = null
    conversationIdRef.current = null
    setCallId(null)
    setConversationId(null)
    setParticipants([])
    setRemotes([])
    setLocalStream(null)
    setMutedState(false)
    mutedRef.current = false
    setMutedPeers([])
    setMicProblem(null)
    setJoinedAt(null)
    setSharing(false)
    setScreenStream(null)
    setRemoteScreens([])
  }, [])

  const leave = useCallback(async () => {
    const cid = conversationIdRef.current
    const kid = callIdRef.current
    teardown()
    if (cid && kid) {
      try {
        await api.leaveCall(cid, kid)
      } catch {
        // ignore; the server also cleans up when the socket drops
      }
    }
  }, [teardown])

  const applyMuted = useCallback((next: boolean) => {
    mutedRef.current = next
    setMutedState(next)
    sessionRef.current?.setMuted(next)
    const cid = conversationIdRef.current
    if (cid && callIdRef.current) void api.setCallMuted(cid, next).catch(() => undefined)
  }, [])

  const startOrJoin = useCallback(
    async (targetConversationId: string) => {
      if (joiningRef.current || conversationIdRef.current === targetConversationId) return
      joiningRef.current = true
      setJoining(true)
      try {
        // One call at a time: joining another chat's call leaves this one.
        if (conversationIdRef.current) await leave()
        const generation = ++generationRef.current
        const stale = () => generation !== generationRef.current
        setError(null)
        const pre = await api.getCall(targetConversationId)
        if (stale()) return
        const session = new CallSession({
          iceServers: (pre.iceServers as RTCIceServer[]) ?? [],
          sendSignal: (to, data) => {
            const cid = conversationIdRef.current
            const kid = callIdRef.current
            if (cid) void api.sendCallSignal(cid, { callId: kid ?? "", to, data }).catch(() => undefined)
          },
          onRemoteStream: setRemote,
          onPeerRemoved: dropRemote,
          onRemoteScreen: setRemoteScreen,
          onShareEnded: () => { setSharing(false); setScreenStream(null) },
          onLocalStream: (stream) => { if (sessionRef.current === session) setLocalStream(stream) },
          onMicProblem: (problem) => { if (sessionRef.current === session) setMicProblem(problem) },
        })
        sessionRef.current = session
        conversationIdRef.current = targetConversationId
        setConversationId(targetConversationId)
        setIncoming((current) => (current && current.conversationId === targetConversationId ? null : current))
        // Without a microphone the call is joined muted, for listening; the
        // mute button tries the microphone again.
        const micOpen = await session.start()
        if (stale()) {
          session.stop()
          return
        }
        if (!micOpen) {
          mutedRef.current = true
          setMutedState(true)
          session.setMuted(true)
        }
        setLocalStream(session.getLocalStream())
        const res = await api.joinCall(targetConversationId)
        if (stale()) {
          // Left while the join was on its way.
          void api.leaveCall(targetConversationId, res.call.callId).catch(() => undefined)
          return
        }
        callIdRef.current = res.call.callId
        setCallId(res.call.callId)
        setJoinedAt(Date.now())
        setParticipants(res.call.participants)
        setMutedPeers((res.call.muted ?? []).filter((id) => id !== selfId))
        noteOngoing(targetConversationId, res.call.participants)
        syncPeers(res.call.participants)
        // Turned off while the call was connecting: the others learn it now.
        if (mutedRef.current) void api.setCallMuted(targetConversationId, true).catch(() => undefined)
      } catch (err) {
        teardown()
        // A refusal from the other side's privacy settings is not a failure of
        // the microphone, and deserves its own wording.
        const status = (err as { status?: number } | null)?.status
        if (status === 403) {
          setError(refusedMessage ?? translate(getActiveLang(), "callRefused"))
          return
        }
        setError(errorText(err, translate(getActiveLang(), "callStartFailed")))
      } finally {
        joiningRef.current = false
        setJoining(false)
      }
    },
    [dropRemote, setRemote, setRemoteScreen, teardown, leave, syncPeers, noteOngoing, refusedMessage, selfId],
  )

  const acceptIncoming = useCallback(() => {
    const invite = incomingRef.current
    if (invite) void startOrJoin(invite.conversationId)
  }, [startOrJoin])

  // The others in the call are told, so they can show it under your picture.
  // Turning the microphone on needs one: if it is gone (unplugged headset, or
  // there was none when the call started), it is opened again first.
  const toggleMute = useCallback(() => {
    const session = sessionRef.current
    const next = !mutedRef.current
    if (!next && session && !session.hasMic()) {
      void session.ensureMic().then((open) => {
        if (open && sessionRef.current === session) applyMuted(false)
      })
      return
    }
    applyMuted(next)
  }, [applyMuted])

  const toggleShare = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    if (session.isSharing()) {
      session.stopScreenShare()
      setSharing(false)
      setScreenStream(null)
      return
    }
    void session.startScreenShare().then((stream) => {
      if (!stream) return
      setSharing(true)
      setScreenStream(stream)
    }).catch(() => undefined)
  }, [])
  // Other tabs of this browser ring too; declining in one quiets them all.
  const tabsRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel("frontierx-calls")
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; userId?: string; callId?: string } | null
      if (!data || data.type !== "dismiss" || data.userId !== selfId) return
      if (incomingRef.current && incomingRef.current.callId === data.callId) setIncoming(null)
    }
    tabsRef.current = channel
    return () => {
      channel.close()
      tabsRef.current = null
    }
  }, [selfId])
  const dismissIncoming = useCallback(() => {
    const invite = incomingRef.current
    setIncoming(null)
    if (invite) {
      try {
        tabsRef.current?.postMessage({ type: "dismiss", userId: selfId, callId: invite.callId })
      } catch {
        // the other tabs keep ringing until the call is answered or ends
      }
    }
  }, [selfId])
  const clearError = useCallback(() => setError(null), [])

  // While the realtime connection was gone, events were missed: the call may
  // have ended, people may have come and gone, or the server may have taken
  // this device out of the call. The server's roster decides.
  const resync = useCallback(() => {
    const cid = conversationIdRef.current
    const session = sessionRef.current
    if (!cid || !session || !callIdRef.current || resyncingRef.current) return
    resyncingRef.current = true
    const generation = generationRef.current
    const stale = () => generation !== generationRef.current || sessionRef.current !== session
    void (async () => {
      try {
        const res = await api.getCall(cid)
        if (stale()) return
        const call = res.call
        if (!call) {
          noteOngoing(cid, null)
          teardown()
          return
        }
        if (call.participants.includes(selfId)) {
          callIdRef.current = call.callId
          setCallId(call.callId)
          setParticipants(call.participants)
          setMutedPeers((call.muted ?? []).filter((id) => id !== selfId))
          noteOngoing(cid, call.participants)
          syncPeers(call.participants)
          return
        }
        // Dropped while away: join again, with fresh connections to everyone.
        session.resetPeers()
        const joined = await api.joinCall(cid)
        if (stale()) return
        callIdRef.current = joined.call.callId
        setCallId(joined.call.callId)
        setParticipants(joined.call.participants)
        setMutedPeers((joined.call.muted ?? []).filter((id) => id !== selfId))
        noteOngoing(cid, joined.call.participants)
        syncPeers(joined.call.participants)
        if (mutedRef.current) void api.setCallMuted(cid, true).catch(() => undefined)
      } catch (err) {
        // No longer a member of the chat: the call is over for this device.
        const status = (err as { status?: number } | null)?.status
        if (!stale() && (status === 403 || status === 404)) teardown()
      } finally {
        resyncingRef.current = false
      }
    })()
  }, [selfId, syncPeers, teardown, noteOngoing])

  const noteCall = useCallback((cid: string, call: CallState | null) => {
    noteOngoing(cid, call ? call.participants : null)
  }, [noteOngoing])

  const handleEvent = useCallback(
    (event: WsEvent) => {
      switch (event.type) {
        case "call.invite": {
          setOngoing((prev) => (prev[event.conversationId] ? prev : { ...prev, [event.conversationId]: [event.from] }))
          // Already in this call (answered on another device): nothing rings.
          if (conversationIdRef.current === event.conversationId) return
          setIncoming({ conversationId: event.conversationId, callId: event.callId, from: event.from })
          return
        }
        case "call.participants": {
          noteOngoing(event.conversationId, event.participants)
          // Answered in another tab or on another device: this one stops ringing.
          if (event.conversationId !== conversationIdRef.current) {
            if (incomingRef.current && incomingRef.current.conversationId === event.conversationId && event.participants.includes(selfId)) setIncoming(null)
            return
          }
          if (callIdRef.current && !event.participants.includes(selfId)) {
            // The server no longer counts this device in: find out why.
            resync()
            return
          }
          setParticipants(event.participants)
          if (event.muted) setMutedPeers(event.muted.filter((id) => id !== selfId))
          syncPeers(event.participants)
          return
        }
        case "call.joined": {
          if (event.conversationId !== conversationIdRef.current) return
          const next = participantsRef.current.includes(event.userId)
            ? participantsRef.current
            : participantsRef.current.concat(event.userId)
          setParticipants(next)
          syncPeers(next)
          return
        }
        case "call.mute": {
          if (event.conversationId !== conversationIdRef.current || event.userId === selfId) return
          setMutedPeers((prev) => {
            const rest = prev.filter((id) => id !== event.userId)
            return event.muted ? rest.concat([event.userId]) : rest
          })
          return
        }
        case "call.left": {
          setOngoing((prev) => {
            const roster = prev[event.conversationId]
            if (!roster || !roster.includes(event.userId)) return prev
            const rest = roster.filter((id) => id !== event.userId)
            const next = { ...prev }
            if (rest.length) next[event.conversationId] = rest
            else delete next[event.conversationId]
            return next
          })
          if (event.conversationId !== conversationIdRef.current) return
          setMutedPeers((prev) => prev.filter((id) => id !== event.userId))
          if (sessionRef.current) sessionRef.current.removePeer(event.userId)
          setRemoteScreens((prev) => prev.filter((entry) => entry.peerId !== event.userId))
          setParticipants((prev) => prev.filter((id) => id !== event.userId))
          return
        }
        case "call.ended": {
          noteOngoing(event.conversationId, null)
          if (event.conversationId === conversationIdRef.current) {
            teardown()
          } else if (incomingRef.current && incomingRef.current.callId === event.callId) {
            setIncoming(null)
          }
          return
        }
        case "call.signal": {
          if (event.conversationId !== conversationIdRef.current) return
          if (sessionRef.current) void sessionRef.current.handleSignal(event.from, event.data as SignalData)
          return
        }
        default:
          return
      }
    },
    [selfId, teardown, syncPeers, noteOngoing, resync],
  )

  // Signing out or switching accounts unmounts the chat: the call ends here
  // and the others are told right away.
  useEffect(() => {
    return () => {
      const cid = conversationIdRef.current
      const kid = callIdRef.current
      if (sessionRef.current) sessionRef.current.stop()
      sessionRef.current = null
      if (cid && kid) void api.leaveCall(cid, kid).catch(() => undefined)
    }
  }, [])

  return {
    activeConversationId: conversationId,
    callId,
    participants,
    muted,
    mutedPeers,
    incoming,
    remotes,
    localStream,
    error,
    micProblem,
    joinedAt,
    joining,
    ongoing,
    startOrJoin,
    acceptIncoming,
    leave,
    toggleMute,
    sharing,
    screenStream,
    remoteScreens,
    toggleShare,
    dismissIncoming,
    clearError,
    handleEvent,
    resync,
    noteCall,
  }
}
