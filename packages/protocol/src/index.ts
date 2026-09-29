// FrontierX wire protocol: versioned shared types for client/server sync.

export const PROTOCOL_VERSION = 1

export type ConversationKind = "direct" | "group" | "channel"
export type MemberRole = "owner" | "admin" | "member" | "restricted"
export type ReceiptState = "sent" | "delivered" | "read"

/** File replica lifecycle states (see docs/FILE_LIFECYCLE.md). */
export type ReplicaState =
  | "LOCAL_AVAILABLE"
  | "BACKUP_UPLOADING"
  | "TEMP_SERVER_BACKUP"
  | "RESTORING"
  | "MISSING"
  | "EXPIRED"
  | "PURGED"

export interface MessageEnvelope {
  id: string
  conversationId: string
  senderId: string
  /**
   * Encrypted payload, base64. Interim envelope for M1; replaced by the
   * libsignal/MLS ratchet in M4. This is documented, not presented as final.
   */
  ciphertext: string
  createdAt: string
  replyTo?: string | null
  editedAt?: string | null
  deletedAt?: string | null
  /** Sent without a notification sound or push on the recipients' side. */
  silent?: boolean
}

export interface Reaction {
  messageId: string
  userId: string
  emoji: string
  at: string
}

export interface PinnedMessage {
  conversationId: string
  messageId: string
  pinnedBy: string
  pinnedAt: string
}

export interface ConversationDraft {
  conversationId: string
  userId: string
  ciphertext: string
  updatedAt: string
}
export interface ConversationFolder { id: string; userId: string; name: string; createdAt: string; conversationIds: string[] }

/** Poll contents remain in the encrypted message payload; this state only contains opaque option indexes and aggregates. */
export interface PollSummary {
  messageId: string
  conversationId: string
  creatorId: string
  optionCount: number
  multipleChoice: boolean
  quiz: boolean
  closedAt: string | null
  createdAt: string
  optionCounts: number[]
  totalVoters: number
  /** Present only in the requesting member's HTTP response, never in realtime fan-out. */
  myOptionIndexes: number[]
}

export interface PollRealtimeUpdate {
  messageId: string
  optionCounts: number[]
  totalVoters: number
  closedAt: string | null
}

export type WsEvent =
  | { type: "message.created"; message: MessageEnvelope }
  | { type: "message.updated"; message: MessageEnvelope }
  | { type: "message.deleted"; conversationId: string; messageId: string }
  | { type: "message.pinned"; conversationId: string; messageId: string; pinnedBy: string; pinnedAt: string | null; active: boolean }
  | { type: "message.saved"; conversationId: string; messageId: string; userId: string; savedAt: string | null; active: boolean }
  | { type: "reaction.updated"; conversationId: string; messageId: string; userId: string; emoji: string; active: boolean }
  | { type: "member.role_changed"; conversationId: string; userId: string; role: MemberRole }
  | { type: "conversation.state_changed"; conversationId: string; userId: string; archivedAt: string | null }
  | { type: "conversation.muted"; conversationId: string; userId: string; mutedUntil: string | null }
  | { type: "conversation.ttl_changed"; conversationId: string; ttlSeconds: number | null }
  | { type: "folder.updated"; userId: string; folderId: string; action: "created" | "updated" | "deleted" }
  | { type: "poll.updated"; conversationId: string; update: PollRealtimeUpdate }
  | { type: "draft.updated"; conversationId: string; userId: string; ciphertext: string | null; updatedAt: string | null }
  | { type: "receipt.updated"; messageId: string; userId: string; state: ReceiptState; at: string }
  | { type: "typing"; conversationId: string; userId: string }
  // lastSeenAt: when the user was last online, if the viewer may see it.
  | { type: "presence.updated"; conversationId: string; userId: string; online: boolean; lastSeenAt?: string | null }
  | { type: "file.state_changed"; fileAssetId: string; replicaId: string; state: ReplicaState; tempExpiresAt?: string | null }
  | { type: "call.invite"; conversationId: string; callId: string; from: string; media: CallMedia; at: string }
  | { type: "call.participants"; conversationId: string; callId: string; participants: string[] }
  | { type: "call.joined"; conversationId: string; callId: string; userId: string }
  | { type: "call.left"; conversationId: string; callId: string; userId: string }
  | { type: "call.ended"; conversationId: string; callId: string }
  | { type: "call.signal"; conversationId: string; callId: string; from: string; to: string; data: unknown }
  // Key system v2: members are asked to hand keys over, a new key epoch became
  // current, copies of keys arrived for this user, a device asks to be linked.
  | { type: "keys.shares_needed"; conversationId: string }
  | { type: "keys.epoch_created"; conversationId: string; keyId: string; createdBy: string }
  | { type: "keys.shares_added"; conversationId: string; keyIds: string[] }
  | { type: "keys.link_requested"; request: { id: string; label: string; createdAt: string; expiresAt: string; ephemeralPublicKey: string } }
  | { type: "keys.link_resolved"; id: string; status: "approved" | "denied" }
  | { type: "keys.account_reset"; sessionId: string }
  | { type: "scheduled.updated"; conversationId: string; count: number }
  | { type: "member.removed"; conversationId: string; userId: string }

export type CallMedia = "audio"

export interface CallState {
  callId: string
  conversationId: string
  media: CallMedia
  startedBy: string
  startedAt: string
  participants: string[]
}
