import type { BotButton } from "./botmsg"
import type { MediaEnvelope } from "./media"
import type { PollEnvelope } from "./poll"
import type { LinkPreviewCard } from "./linkmsg"
import type { ContactPayload, LocationPayload } from "./richmsg"

export type ConversationKind = "direct" | "group" | "channel"
export type MemberRole = "owner" | "admin" | "member" | "restricted"
export type ReceiptState = "sent" | "delivered" | "read"

export type ReplicaState =
	| "LOCAL_AVAILABLE"
	| "BACKUP_UPLOADING"
	| "TEMP_SERVER_BACKUP"
	| "RESTORING"
	| "MISSING"
	| "EXPIRED"
	| "PURGED"

export type User = {
	id: string
	username: string
	displayName: string
	publicKey?: string | null
	avatar?: string | null
	isBot?: boolean
}

export type AuthResult = { token: string; user: User }
export type SessionDevice = {
	id: string
	label: string
	createdAt: string
	lastSeenAt: string
	expiresAt?: string | null
	current: boolean
}

export type ConversationPeer = { id: string; username: string; displayName: string; avatar: string | null; isBot?: boolean }

export type Conversation = {
	id: string
	kind: ConversationKind
	title: string | null
	createdBy: string
	createdAt: string
	archivedAt?: string | null
	mutedUntil?: string | null
	avatar?: string | null
	isSelf?: boolean
	peer?: ConversationPeer | null
	ttlSeconds?: number | null
	// Your own scheduled messages waiting in this chat.
	scheduledCount?: number
}
export type ConversationFolder = { id: string; userId: string; name: string; createdAt: string; conversationIds: string[] }

export type Member = {
	conversationId: string
	userId: string
	role: MemberRole
	joinedAt: string
	archivedAt?: string | null
}

export type MessageEnvelope = {
	id: string
	conversationId: string
	senderId: string
	ciphertext: string
	createdAt: string
	replyTo?: string | null
	editedAt?: string | null
	deletedAt?: string | null
	silent?: boolean
}

export type FileAsset = {
	id: string
	conversationId: string
	name: string
	mime: string
	size: number
	createdBy: string
	createdAt: string
}

export type Replica = { id: string; fileAssetId: string; state: ReplicaState; tempExpiresAt: string | null }
export type Reaction = { messageId: string; userId: string; emoji: string; at: string }
export type PinnedMessage = { conversationId: string; messageId: string; pinnedBy: string; pinnedAt: string }
export type ConversationDraft = { conversationId: string; userId: string; ciphertext: string; updatedAt: string }
export type SavedMessage = { message: MessageEnvelope; savedAt: string }
export type PollSummary = {
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
	myOptionIndexes: number[]
}
export type PollRealtimeUpdate = { messageId: string; optionCounts: number[]; totalVoters: number; closedAt: string | null }

export type Friend = { id: string; username: string; displayName: string; avatar: string | null; conversationId: string }
export type UserSummary = { id: string; username: string; displayName: string; avatar: string | null; isBot?: boolean }

export type WsEvent =
	| { type: "ready"; userId: string }
	| { type: "message.created"; message: MessageEnvelope }
	| { type: "message.updated"; message: MessageEnvelope }
	| { type: "message.deleted"; conversationId: string; messageId: string }
	| { type: "message.pinned"; conversationId: string; messageId: string; pinnedBy: string; pinnedAt: string | null; active: boolean }
	| { type: "message.saved"; conversationId: string; messageId: string; userId: string; savedAt: string | null; active: boolean }
	| { type: "member.role_changed"; conversationId: string; userId: string; role: MemberRole }
	| { type: "conversation.state_changed"; conversationId: string; userId: string; archivedAt: string | null }
	| { type: "conversation.muted"; conversationId: string; userId: string; mutedUntil: string | null }
	| { type: "conversation.ttl_changed"; conversationId: string; ttlSeconds: number | null }
	| { type: "folder.updated"; userId: string; folderId: string; action: "created" | "updated" | "deleted" }
	| { type: "poll.updated"; conversationId: string; update: PollRealtimeUpdate }
	| { type: "draft.updated"; conversationId: string; userId: string; ciphertext: string | null; updatedAt: string | null }
	| { type: "typing"; conversationId: string; userId: string }
	// lastSeenAt: when the user was last online, if you may see it (null: hidden).
	| { type: "presence.updated"; conversationId: string; userId: string; online: boolean; lastSeenAt?: string | null }
	| { type: "reaction.updated"; conversationId: string; messageId: string; userId: string; emoji: string; active: boolean }
	| { type: "receipt.updated"; messageId: string; userId: string; state: ReceiptState; at: string }
	| { type: "group.invite"; invite: GroupInvite }
	| { type: "file.state_changed"; fileAssetId: string; replicaId: string; state: ReplicaState; tempExpiresAt: string | null }
	| { type: "call.invite"; conversationId: string; callId: string; from: string; media: CallMedia; at: string }
	| { type: "call.participants"; conversationId: string; callId: string; participants: string[] }
	| { type: "call.joined"; conversationId: string; callId: string; userId: string }
	| { type: "call.left"; conversationId: string; callId: string; userId: string }
	| { type: "call.ended"; conversationId: string; callId: string }
	| { type: "call.signal"; conversationId: string; callId: string; from: string; to: string; data: unknown }
	| { type: "user.profile_updated"; userId: string; displayName: string; avatar: string | null }
	| { type: "conversation.profile_updated"; conversationId: string; title: string | null; avatar: string | null }
	| { type: "friend.request"; requestId: string; fromUser: string; toUser: string }
	| { type: "friend.accepted"; conversation: Conversation }
	| { type: "friend.declined"; requestId: string }
	| { type: "friend.removed"; conversationId: string; by: string }
	| { type: "conversation.added"; conversation: Conversation }
	| { type: "conversation.deleted"; conversationId: string }
	| { type: "member.added"; conversationId: string; userId: string }
	| { type: "member.removed"; conversationId: string; userId: string }
	| { type: "keys.shares_needed"; conversationId: string }
	| { type: "keys.epoch_created"; conversationId: string; keyId: string; createdBy: string }
	| { type: "keys.shares_added"; conversationId: string; keyIds: string[] }
	| { type: "keys.link_requested"; request: LinkRequestInfo }
	| { type: "keys.link_resolved"; id: string; status: "approved" | "denied" }
	| { type: "keys.account_reset"; sessionId: string }
	| { type: "scheduled.updated"; conversationId: string; count: number }
	| { type: "bot.callback_answer"; callbackId: string; conversationId: string; botId: string; text: string | null; alert: boolean }
	| { type: "push.test"; title: string; body: string }

export type CallMedia = "audio"

export interface CallState { callId: string; conversationId: string; media: CallMedia; startedBy: string; startedAt: string; participants: string[] }

export type DisplayMessage = {
	id: string
	conversationId: string
	senderId: string
	createdAt: string
	replyTo?: string | null
	text: string | null
	locked: boolean
	editedAt?: string | null
	deleted?: boolean
	media?: MediaEnvelope | null
	poll?: PollEnvelope | null
	link?: LinkPreviewCard | null
	location?: LocationPayload | null
	contact?: ContactPayload | null
	silent?: boolean
	// Buttons under a bot's message (drawn only when the sender is a bot).
	buttons?: BotButton[][] | null
}

export type ConversationMember = {
	userId: string
	role: MemberRole
	username: string
	displayName: string
	publicKey: string | null
	avatar?: string | null
	isBot?: boolean
}

export type WrappedKeyEntry = { memberId: string; ephemeralPublicKey: string; iv: string; ciphertext: string }

export type FriendRequest = { id: string; fromUser: string; toUser: string; status: "pending" | "accepted" | "declined"; createdAt: string; username: string | null; displayName: string | null; avatar: string | null }
export type GroupInvite = { id: string; conversationId: string; conversationTitle: string | null; conversationKind: string; fromUser: string; fromName: string | null; createdAt: string }
export type UserSettings = { requireInvite: boolean }

export type PrivacyPolicy = "everyone" | "contacts" | "nobody"
// "lastSeen" is the online-status setting; "seenTime" the time of the last visit.
export type PrivacyScope = "lastSeen" | "seenTime" | "calls"
export type PrivacyMode = "allow" | "deny"
export type PrivacyException = { targetId: string; scope: PrivacyScope; mode: PrivacyMode }
export type UserPrivacySettings = {
	requireInvite: boolean
	ghostMode: boolean
	lastSeenPolicy: PrivacyPolicy
	seenTimePolicy: PrivacyPolicy
	callsPolicy: PrivacyPolicy
	exceptions: PrivacyException[]
}
export type Sticker = { id: string; ownerId: string; data: string; createdAt: string }
// --- key system v2 ---
export type SealedValue = { iv: string; ciphertext: string }
export type SlotInput = { kind: "password" | "recovery" | "identity"; kdf: Record<string, unknown>; iv: string; ciphertext: string; label?: string | null }
export type StoredSlotInfo = SlotInput & { id: string; stale: boolean; createdAt: string; updatedAt: string }
export type VaultItem = { scope: "identity" | "cek"; itemId: string; conversationId: string | null; keyId: string | null; iv: string; ciphertext: string }
export type VaultItemInput =
	| { scope: "identity"; itemId: string; iv: string; ciphertext: string }
	| { scope: "cek"; conversationId: string; keyId: string; iv: string; ciphertext: string }
export type LegacyBackup = { salt: string; iv: string; ciphertext: string; iterations: number; publicKey: string }
export type KeyStateResponse = {
	accountKey: { check: SealedValue; createdAt: string } | null
	slots: StoredSlotInfo[]
	publicKey: string | null
	legacyBackup: LegacyBackup | null
	identities: Array<{ itemId: string; iv: string; ciphertext: string }>
	vaultCount: number
	passwordChangedAt: string | null
}
export type ShareInfo = { keyId: string; ephemeralPublicKey: string; iv: string; ciphertext: string; recipientKey: string | null }
export type ShareInput = { keyId?: string; memberId: string; ephemeralPublicKey: string; iv: string; ciphertext: string; recipientKey: string }
export type MissingShare = { conversationId: string; keyId: string; memberId: string; publicKey: string }
export type KeyEpochInfo = { keyId: string; createdBy: string; createdAt: string; check: string | null }
export type ConversationKeysResponse = {
	currentKeyId: string | null
	rekeyNeeded: boolean
	epochs: KeyEpochInfo[]
	shares: ShareInfo[]
	vault: Array<{ keyId: string | null; iv: string; ciphertext: string }>
	missing: MissingShare[]
}
export type LinkRequestInfo = { id: string; label: string; createdAt: string; expiresAt: string; ephemeralPublicKey: string }

// --- scheduled messages ---
export type ScheduledMessage = { id: string; conversationId: string; ciphertext: string; replyTo: string | null; silent: boolean; sendAt: string; createdAt: string; updatedAt: string }

// --- bots ---
export type BotCommand = { command: string; description: string }
export type BotInfo = {
	id: string
	username: string
	displayName: string
	avatar: string | null
	description: string | null
	allowGroups: boolean
	commands: BotCommand[]
	webhook: { url: string; failures: number } | null
	hasIdentityKey: boolean
	createdAt: string
	tokenCreatedAt: string
	lastUsedAt: string | null
}

// How a message goes out: silently (no sound or push on the other side) and/or
// at a later time (the server delivers it then).
export type SendOptions = { silent?: boolean; sendAt?: string | null }
