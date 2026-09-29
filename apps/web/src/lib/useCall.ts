import { useCallback, useEffect, useRef, useState } from "react"
import type { WsEvent } from "./types"
import { api } from "./api"
import { CallSession } from "./webrtc"
import { errorText } from "./errorText"
import { getActiveLang, translate } from "./i18n"
import type { SignalData } from "./webrtc"

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
  incoming: IncomingCall | null
  remotes: RemoteAudio[]
  localStream: MediaStream | null
  error: string | null
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
}

// refusedMessage is the localised wording for a call the other side does not
// accept; the hook itself has no access to the translations.
export function useCall(selfId: string, refusedMessage?: string): UseCall {
  const [callId, setCallId] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [participants, setParticipants] = useState<string[]>([])
  const [muted, setMutedState] = useState(false)
  const [incoming, setIncoming] = useState<IncomingCall | null>(null)
  const [remotes, setRemotes] = useState<RemoteAudio[]>([])
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sessionRef = useRef<CallSession | null>(null)
  const callIdRef = useRef<string | null>(null)
  const conversationIdRef = useRef<string | null>(null)
  const incomingRef = useRef<IncomingCall | null>(null)
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
    setSharing(false)
    setScreenStream(null)
    setRemoteScreens([])
  }, [])

  const startOrJoin = useCallback(
    async (targetConversationId: string) => {
      if (conversationIdRef.current) return
      setError(null)
      try {
        const pre = await api.getCall(targetConversationId)
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
        })
        sessionRef.current = session
        conversationIdRef.current = targetConversationId
        setConversationId(targetConversationId)
        setIncoming(null)
        await session.start()
        setLocalStream(session.getLocalStream())
        const res = await api.joinCall(targetConversationId)
        callIdRef.current = res.call.callId
        setCallId(res.call.callId)
        setParticipants(res.call.participants)
        syncPeers(res.call.participants)
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
      }
    },
    [dropRemote, setRemote, setRemoteScreen, teardown, syncPeers, refusedMessage],
  )

  const acceptIncoming = useCallback(() => {
    const invite = incomingRef.current
    if (invite) void startOrJoin(invite.conversationId)
  }, [startOrJoin])

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

  const toggleMute = useCallback(() => {
    setMutedState((current) => {
      const next = !current
      if (sessionRef.current) sessionRef.current.setMuted(next)
      return next
    })
  }, [])

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
  const dismissIncoming = useCallback(() => setIncoming(null), [])
  const clearError = useCallback(() => setError(null), [])

  const handleEvent = useCallback(
    (event: WsEvent) => {
      switch (event.type) {
        case "call.invite": {
          if (conversationIdRef.current) return
          setIncoming({ conversationId: event.conversationId, callId: event.callId, from: event.from })
          return
        }
        case "call.participants": {
          if (event.conversationId !== conversationIdRef.current) return
          setParticipants(event.participants)
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
        case "call.left": {
          if (event.conversationId !== conversationIdRef.current) return
          if (sessionRef.current) sessionRef.current.removePeer(event.userId)
          setRemoteScreens((prev) => prev.filter((entry) => entry.peerId !== event.userId))
          setParticipants((prev) => prev.filter((id) => id !== event.userId))
          return
        }
        case "call.ended": {
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
    [selfId, teardown, syncPeers],
  )

  useEffect(() => {
    return () => {
      if (sessionRef.current) sessionRef.current.stop()
    }
  }, [])

  return {
    activeConversationId: conversationId,
    callId,
    participants,
    muted,
    incoming,
    remotes,
    localStream,
    error,
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
  }
}