import * as nodeSqlite from "node:sqlite"
import type { ConversationKind, MemberRole, ReplicaState } from "@frontierx/protocol"
import { createHash } from "node:crypto"

// Invite codes are stored only as a salted digest so a stolen database
// cannot be used to join private groups. Links handed out earlier keep
// working because the server hashes whatever code the client presents.
function inviteCodeHash(code: string): string {
  return "h1:" + createHash("sha256").update("frontierx:invite:" + String(code)).digest("hex")
}

// Persistence behind a narrow, synchronous interface. node:sqlite is a built-in
// (Node 22.5+), so the first stage runs with zero external services. The
// Postgres adapter for staging/production implements the same method surface
// (see docs/ARCHITECTURE.md and deploy/).

type Stmt = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, any> | undefined
  all(...params: unknown[]): Record<string, any>[]
}
type Db = { exec(sql: string): void; prepare(sql: string): Stmt; close(): void }
const DatabaseSync = (nodeSqlite as unknown as { DatabaseSync: new (path: string) => Db }).DatabaseSync

export interface UserRow {
  id: string
  username: string
  passwordHash: string
  displayName: string
  createdAt: string
  publicKey: string | null
  avatar: string | null
  isBot?: boolean
  botOwnerId?: string | null
}
export interface SessionRow {
  id: string
  tokenHash: string
  userId: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  deviceId?: string | null
}
export interface ConversationRow {
  id: string
  kind: ConversationKind
  title: string | null
  createdBy: string
  createdAt: string
  avatar?: string | null
  isSelf?: boolean
  archivedAt?: string | null
  mutedUntil?: string | null
  ttlSeconds?: number | null
}
export interface MemberRow {
  conversationId: string
  userId: string
  role: MemberRole
  joinedAt: string
  archivedAt?: string | null
  mutedUntil?: string | null
}
export interface PinnedMessageRow {
  conversationId: string
  messageId: string
  pinnedBy: string
  pinnedAt: string
}
export interface ConversationDraftRow {
  conversationId: string
  userId: string
  ciphertext: string
  updatedAt: string
}
export interface ConversationFolderRow { id: string; userId: string; name: string; createdAt: string; conversationIds: string[] }

export type PrivacyPolicy = "everyone" | "contacts" | "nobody"
// "lastSeen" is the historical name of the online-status setting (who sees
// that you are online right now); "seenTime" governs who sees when you were
// last online.
export type PrivacyScope = "lastSeen" | "seenTime" | "calls"
export type PrivacyMode = "allow" | "deny"
export interface UserSettingsRow {
  requireInvite: boolean
  ghostMode: boolean
  lastSeenPolicy: PrivacyPolicy
  seenTimePolicy: PrivacyPolicy
  callsPolicy: PrivacyPolicy
}
export interface PrivacyExceptionRow { targetId: string; scope: PrivacyScope; mode: PrivacyMode }

function normalisePolicy(value: unknown): PrivacyPolicy {
  if (value === "nobody") return "nobody"
  if (value === "contacts") return "contacts"
  return "everyone"
}
export interface FriendRequestRow { id: string; fromUser: string; toUser: string; status: string; createdAt: string }
export interface GroupInviteRow { id: string; conversationId: string; fromUser: string; toUser: string; createdAt: string }
export interface InviteRow { code: string; conversationId: string; createdBy: string; createdAt: string; expiresAt?: string | null }
export interface SavedMessageRow { userId: string; message: MessageRow; savedAt: string }
export interface PollRow {
  messageId: string
  conversationId: string
  creatorId: string
  optionCount: number
  multipleChoice: boolean
  quiz: boolean
  closedAt: string | null
  createdAt: string
}
export interface PollSnapshot extends PollRow {
  optionCounts: number[]
  totalVoters: number
  myOptionIndexes: number[]
}
export interface MessageRow {
  id: string
  conversationId: string
  senderId: string
  ciphertext: string
  replyTo: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  // Delivered without a push notification or a sound on the other side.
  silent?: boolean
}
export interface StickerRow {
  id: string
  ownerId: string
  data: string
  createdAt: string
}
export interface ReactionRow {
  messageId: string
  userId: string
  emoji: string
  at: string
}
export interface FileAssetRow {
  id: string
  conversationId: string
  ownerId: string
  name: string
  mime: string
  size: number
  manifestJson: string
  createdAt: string
}
export interface ReplicaRow {
  id: string
  fileAssetId: string
  state: ReplicaState
  tempExpiresAt: number | null
  updatedAt: number
}

// Optional account email (used only for recovery), one-time codes and
// UnifiedPush endpoints. Kept in separate statements so existing databases pick
// them up on the next start without a migration tool.
const EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id, purpose);
CREATE TABLE IF NOT EXISTS push_endpoints (
  endpoint TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_endpoints_user ON push_endpoints(user_id);
`

const EXTRA_MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN email TEXT",
  "ALTER TABLE users ADD COLUMN email_verified_at TEXT",
]

export interface EmailCodeRow {
  id: string
  userId: string
  email: string
  purpose: string
  codeHash: string
  createdAt: string
  expiresAt: string
  attempts: number
}

export interface PushEndpointRow {
  id: string
  userId: string
  endpoint: string
  deviceId: string | null
  createdAt: string
  lastSeenAt: string
}

function mapEmailCode(r: any): EmailCodeRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    email: String(r.email),
    purpose: String(r.purpose),
    codeHash: String(r.code_hash),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    attempts: Number(r.attempts ?? 0),
  }
}

function mapPushEndpoint(r: any): PushEndpointRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    endpoint: String(r.endpoint),
    deviceId: r.device_id != null ? String(r.device_id) : null,
    createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at),
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  device_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  archived_at TEXT,
  muted_until TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS pinned_messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_pinned_conversation ON pinned_messages(conversation_id, pinned_at DESC);
CREATE TABLE IF NOT EXISTS conversation_drafts (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON conversation_drafts(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS saved_messages (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_messages_user ON saved_messages(user_id, saved_at DESC);
CREATE TABLE IF NOT EXISTS conversation_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_folders_user ON conversation_folders(user_id, created_at ASC);
CREATE TABLE IF NOT EXISTS folder_conversations (
  folder_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  PRIMARY KEY (folder_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  reply_to TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at, id);
CREATE TABLE IF NOT EXISTS polls (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  option_count INTEGER NOT NULL,
  multiple_choice INTEGER NOT NULL,
  quiz INTEGER NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_conversation ON polls(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  option_indexes TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS file_assets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replicas (
  id TEXT PRIMARY KEY,
  file_asset_id TEXT NOT NULL,
  state TEXT NOT NULL,
  temp_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replicas_asset ON replicas(file_asset_id);
CREATE TABLE IF NOT EXISTS conversation_keys (
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, member_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_pair ON friend_requests(from_user, to_user);
CREATE INDEX IF NOT EXISTS idx_friend_to ON friend_requests(to_user, status);
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_owner ON stickers(owner_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_keys (
  user_id TEXT PRIMARY KEY,
  check_iv TEXT NOT NULL,
  check_ct TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_key_slots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  kdf TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  label TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_key_slots_user ON account_key_slots(user_id, kind);
CREATE TABLE IF NOT EXISTS account_vault (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  item_id TEXT NOT NULL,
  conversation_id TEXT,
  key_id TEXT,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope, item_id)
);
CREATE INDEX IF NOT EXISTS idx_vault_conversation ON account_vault(user_id, conversation_id);
CREATE TABLE IF NOT EXISTS conversation_key_epochs (
  conversation_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_check TEXT,
  PRIMARY KEY (conversation_id, key_id)
);
CREATE TABLE IF NOT EXISTS conversation_key_shares (
  conversation_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  recipient_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_key_shares_member ON conversation_key_shares(member_id, conversation_id);
CREATE TABLE IF NOT EXISTS key_link_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  approved_by_session TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_requests_user ON key_link_requests(user_id, status);
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  reply_to TEXT,
  silent INTEGER NOT NULL DEFAULT 0,
  send_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_sender ON scheduled_messages(sender_id, conversation_id);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  description TEXT,
  allow_groups INTEGER NOT NULL DEFAULT 1,
  commands TEXT NOT NULL DEFAULT '[]',
  webhook_url TEXT,
  webhook_secret TEXT,
  webhook_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  token_created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
CREATE TABLE IF NOT EXISTS bot_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_updates_bot ON bot_updates(bot_id, id);
CREATE TABLE IF NOT EXISTS webpush_subscriptions (
  endpoint TEXT NOT NULL,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_id TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, user_id)
);
CREATE INDEX IF NOT EXISTS idx_webpush_user ON webpush_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at, id);
`

export interface AccountKeyRow { userId: string; checkIv: string; checkCiphertext: string; createdAt: string; updatedAt: string }
export type KeySlotKind = "password" | "recovery" | "identity"
export interface KeySlotRow {
  id: string
  userId: string
  kind: KeySlotKind
  // JSON: how the wrapping key is derived (salt, iterations, ephemeral key...).
  kdf: string
  iv: string
  ciphertext: string
  label: string | null
  stale: boolean
  createdAt: string
  updatedAt: string
}
export interface VaultItemRow {
  userId: string
  scope: "identity" | "cek"
  itemId: string
  conversationId: string | null
  keyId: string | null
  iv: string
  ciphertext: string
  createdAt: string
}
export interface KeyEpochRow { conversationId: string; keyId: string; createdBy: string; createdAt: string; keyCheck: string | null }
export interface KeyShareRow {
  conversationId: string
  keyId: string
  memberId: string
  ephemeralPublicKey: string
  iv: string
  ciphertext: string
  recipientKey: string | null
  createdBy: string
  createdAt: string
}
export interface MissingShareRow { conversationId: string; keyId: string; memberId: string; publicKey: string }
export interface LinkRequestRow {
  id: string
  userId: string
  sessionId: string
  ephemeralPublicKey: string
  label: string
  status: "pending" | "approved" | "denied"
  response: string | null
  approvedBySession: string | null
  createdAt: string
  expiresAt: string
}
export interface ScheduledMessageRow {
  id: string
  conversationId: string
  senderId: string
  ciphertext: string
  replyTo: string | null
  silent: boolean
  sendAt: string
  createdAt: string
  updatedAt: string
}
export interface BotRow {
  id: string
  ownerId: string
  tokenHash: string
  description: string | null
  allowGroups: boolean
  commands: string
  webhookUrl: string | null
  webhookSecret: string | null
  webhookFailures: number
  createdAt: string
  tokenCreatedAt: string
  lastUsedAt: string | null
}
export interface WebPushSubscriptionRow {
  endpoint: string
  userId: string
  p256dh: string
  auth: string
  deviceId: string | null
  createdAt: string
  lastSeenAt: string
}

function mapKeySlot(r: Record<string, any>): KeySlotRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    kind: String(r.kind) as KeySlotKind,
    kdf: String(r.kdf),
    iv: String(r.iv),
    ciphertext: String(r.ciphertext),
    label: r.label != null ? String(r.label) : null,
    stale: Number(r.stale) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}
function mapVaultItem(r: Record<string, any>): VaultItemRow {
  return {
    userId: String(r.user_id),
    scope: String(r.scope) as "identity" | "cek",
    itemId: String(r.item_id),
    conversationId: r.conversation_id != null ? String(r.conversation_id) : null,
    keyId: r.key_id != null ? String(r.key_id) : null,
    iv: String(r.iv),
    ciphertext: String(r.ciphertext),
    createdAt: String(r.created_at),
  }
}
function mapKeyEpoch(r: Record<string, any>): KeyEpochRow {
  return { conversationId: String(r.conversation_id), keyId: String(r.key_id), createdBy: String(r.created_by), createdAt: String(r.created_at), keyCheck: r.key_check != null ? String(r.key_check) : null }
}
function mapKeyShare(r: Record<string, any>): KeyShareRow {
  return {
    conversationId: String(r.conversation_id),
    keyId: String(r.key_id),
    memberId: String(r.member_id),
    ephemeralPublicKey: String(r.ephemeral_public_key),
    iv: String(r.iv),
    ciphertext: String(r.ciphertext),
    recipientKey: r.recipient_key != null ? String(r.recipient_key) : null,
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
  }
}
function mapLinkRequest(r: Record<string, any>): LinkRequestRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    sessionId: String(r.session_id),
    ephemeralPublicKey: String(r.ephemeral_public_key),
    label: String(r.label),
    status: String(r.status) as LinkRequestRow["status"],
    response: r.response != null ? String(r.response) : null,
    approvedBySession: r.approved_by_session != null ? String(r.approved_by_session) : null,
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
  }
}
function mapScheduled(r: Record<string, any>): ScheduledMessageRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    senderId: String(r.sender_id),
    ciphertext: String(r.ciphertext),
    replyTo: r.reply_to != null ? String(r.reply_to) : null,
    silent: Number(r.silent) === 1,
    sendAt: String(r.send_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}
function mapBot(r: Record<string, any>): BotRow {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    tokenHash: String(r.token_hash),
    description: r.description != null ? String(r.description) : null,
    allowGroups: Number(r.allow_groups) === 1,
    commands: String(r.commands ?? "[]"),
    webhookUrl: r.webhook_url != null ? String(r.webhook_url) : null,
    webhookSecret: r.webhook_secret != null ? String(r.webhook_secret) : null,
    webhookFailures: Number(r.webhook_failures ?? 0),
    createdAt: String(r.created_at),
    tokenCreatedAt: String(r.token_created_at),
    lastUsedAt: r.last_used_at != null ? String(r.last_used_at) : null,
  }
}
function mapWebPush(r: Record<string, any>): WebPushSubscriptionRow {
  return {
    endpoint: String(r.endpoint),
    userId: String(r.user_id),
    p256dh: String(r.p256dh),
    auth: String(r.auth),
    deviceId: r.device_id != null ? String(r.device_id) : null,
    createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at),
  }
}

export class Store {
  private db: Db

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
    this.db.exec(EXTRA_SCHEMA)
    for (const migration of EXTRA_MIGRATIONS) {
      try {
        this.db.exec(migration)
      } catch {
        // column already present
      }
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS key_backups (user_id TEXT PRIMARY KEY, salt TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, iterations INTEGER NOT NULL, public_key TEXT NOT NULL, updated_at TEXT NOT NULL)")
    this.db.exec("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, require_invite INTEGER NOT NULL DEFAULT 0)")
    try { this.db.exec("ALTER TABLE user_settings ADD COLUMN ghost_mode INTEGER NOT NULL DEFAULT 0") } catch {}
    // Who may see the last-seen state and who may call. Exceptions live in
    // their own table so a name can override the policy in either direction.
    try { this.db.exec("ALTER TABLE user_settings ADD COLUMN last_seen_policy TEXT NOT NULL DEFAULT 'everyone'") } catch {}
    try { this.db.exec("ALTER TABLE user_settings ADD COLUMN calls_policy TEXT NOT NULL DEFAULT 'everyone'") } catch {}
    // The first version of these settings shipped with only two choices and
    // stored "contacts" as its default; with "everyone" added, rows that were
    // never touched by hand start from the open setting the app had before.
    try { this.db.exec("UPDATE user_settings SET last_seen_policy='everyone' WHERE last_seen_policy='contacts' AND calls_policy='contacts'") } catch {}
    try { this.db.exec("UPDATE user_settings SET calls_policy='everyone' WHERE calls_policy='contacts' AND last_seen_policy='everyone'") } catch {}
    this.db.exec("CREATE TABLE IF NOT EXISTS privacy_exceptions (user_id TEXT NOT NULL, target_id TEXT NOT NULL, scope TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY (user_id, target_id, scope))")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_privacy_exceptions_user ON privacy_exceptions(user_id, scope)")
    // "Last seen time" became its own setting. The single setting before it was
    // labelled as covering both the online status and the time of the last
    // visit, so everyone's choice (and exceptions) carries over once; nobody's
    // time becomes visible just because the setting was split.
    let seenTimeAdded = false
    try {
      this.db.exec("ALTER TABLE user_settings ADD COLUMN seen_time_policy TEXT")
      seenTimeAdded = true
    } catch {}
    if (seenTimeAdded) {
      this.db.exec("UPDATE user_settings SET seen_time_policy=last_seen_policy")
      this.db.exec("INSERT OR IGNORE INTO privacy_exceptions(user_id,target_id,scope,mode) SELECT user_id,target_id,'seenTime',mode FROM privacy_exceptions WHERE scope='lastSeen'")
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS group_invites (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, from_user TEXT NOT NULL, to_user TEXT NOT NULL, created_at TEXT NOT NULL)")
    for (const sql of [
      "ALTER TABLE messages ADD COLUMN edited_at TEXT",
      "ALTER TABLE messages ADD COLUMN deleted_at TEXT",
      "ALTER TABLE users ADD COLUMN public_key TEXT",
      "ALTER TABLE users ADD COLUMN avatar TEXT",
      "ALTER TABLE conversations ADD COLUMN avatar TEXT",
      "ALTER TABLE conversations ADD COLUMN is_self INTEGER",
      "ALTER TABLE members ADD COLUMN archived_at TEXT",
      "ALTER TABLE members ADD COLUMN muted_until TEXT",
      "ALTER TABLE conversations ADD COLUMN ttl_seconds INTEGER",
      "ALTER TABLE sessions ADD COLUMN id TEXT",
      "ALTER TABLE sessions ADD COLUMN label TEXT",
      "ALTER TABLE sessions ADD COLUMN last_seen_at TEXT",
      "ALTER TABLE sessions ADD COLUMN device_id TEXT",
      "ALTER TABLE invites ADD COLUMN expires_at TEXT",
      // When the user was last online (end of the last visible session), and a
      // heartbeat while online so a crash cannot leave a stale time behind.
      "ALTER TABLE users ADD COLUMN last_seen_at TEXT",
      "ALTER TABLE users ADD COLUMN last_active_at TEXT",
    ]) {
      try {
        this.db.exec(sql)
      } catch {
        // column already present
      }
    }
    try {
      this.db.exec("UPDATE sessions SET id=token_hash WHERE id IS NULL OR id='' ")
      this.db.exec("UPDATE sessions SET label='Browser session' WHERE label IS NULL OR label='' ")
      this.db.exec("UPDATE sessions SET last_seen_at=created_at WHERE last_seen_at IS NULL OR last_seen_at='' ")
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id)")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_seen ON sessions(user_id, last_seen_at DESC)")
    } catch {
      // A legacy database can be read-only during teardown; fresh stores have the complete schema.
    }
    // Sessions that were open when the process stopped never saw their
    // disconnect; their last heartbeat is when they were last online.
    try {
      this.db.exec("UPDATE users SET last_seen_at=last_active_at WHERE last_active_at IS NOT NULL AND (last_seen_at IS NULL OR last_active_at > last_seen_at)")
    } catch {}
    this.migrateV2()
  }

  // Key system v2, scheduled and silent messages, bots and web push. Every
  // statement is idempotent so an existing database upgrades in place on the
  // next start, and nothing that older clients rely on is removed.
  private migrateV2(): void {
    this.db.exec(SCHEMA_V2)
    for (const sql of [
      "ALTER TABLE conversations ADD COLUMN current_key_id TEXT",
      "ALTER TABLE conversations ADD COLUMN rekey_needed INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN bot_owner_id TEXT",
      "ALTER TABLE users ADD COLUMN password_changed_at TEXT",
    ]) {
      try {
        this.db.exec(sql)
      } catch {
        // column already present
      }
    }
    // The single per-member conversation key of the first key system becomes
    // the epoch "legacy": its wrapped copies turn into shares of that epoch and
    // it stays the key new messages are sealed with, so nothing is re-keyed.
    if (this.getMeta("keys_v2_legacy_import") !== "done") {
      this.transaction(() => {
        this.db.exec(
          "INSERT OR IGNORE INTO conversation_key_epochs(conversation_id,key_id,created_by,created_at,key_check) " +
            "SELECT conversation_id,'legacy',MIN(created_by),MIN(created_at),NULL FROM conversation_keys GROUP BY conversation_id",
        )
        this.db.exec(
          "INSERT OR IGNORE INTO conversation_key_shares(conversation_id,key_id,member_id,ephemeral_public_key,iv,ciphertext,recipient_key,created_by,created_at) " +
            "SELECT conversation_id,'legacy',member_id,ephemeral_public_key,iv,ciphertext,NULL,created_by,created_at FROM conversation_keys",
        )
        this.db.exec(
          "UPDATE conversations SET current_key_id='legacy' WHERE current_key_id IS NULL AND id IN (SELECT conversation_id FROM conversation_key_epochs WHERE key_id='legacy')",
        )
        this.setMeta("keys_v2_legacy_import", "done")
      })
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN")
    try {
      const out = run()
      this.db.exec("COMMIT")
      return out
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // the transaction never started
      }
      throw error
    }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as Record<string, unknown> | undefined
    return r && r.value != null ? String(r.value) : null
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)
  }

  // --- account key (keys v2) ---
  getAccountKey(userId: string): AccountKeyRow | null {
    const r = this.db.prepare("SELECT * FROM account_keys WHERE user_id=?").get(userId)
    return r ? { userId: String(r.user_id), checkIv: String(r.check_iv), checkCiphertext: String(r.check_ct), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : null
  }
  // Creates the account key record together with its first slots and vault
  // items. Refuses (returns false) when the account already has one, so two
  // devices can never end up with competing account keys.
  createAccountKey(input: { userId: string; checkIv: string; checkCiphertext: string; slots: KeySlotRow[]; vault: VaultItemRow[]; publicKey?: string | null; now: string }): boolean {
    return this.transaction(() => {
      if (this.getAccountKey(input.userId)) return false
      this.db
        .prepare("INSERT INTO account_keys(user_id,check_iv,check_ct,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(input.userId, input.checkIv, input.checkCiphertext, input.now, input.now)
      for (const slot of input.slots) this.insertKeySlot(slot)
      for (const item of input.vault) this.insertVaultItem(item)
      if (input.publicKey) this.setUserPublicKey(input.userId, input.publicKey)
      return true
    })
  }
  // "Start over": the account's keys are replaced as a whole. Shares that were
  // wrapped for the old identity are dropped so other members hand the chat
  // keys over again, and every group re-keys on its next message.
  resetAccountKeys(input: { userId: string; checkIv: string; checkCiphertext: string; slots: KeySlotRow[]; vault: VaultItemRow[]; publicKey: string; now: string }): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM account_key_slots WHERE user_id=?").run(input.userId)
      this.db.prepare("DELETE FROM account_vault WHERE user_id=?").run(input.userId)
      this.db.prepare("DELETE FROM account_keys WHERE user_id=?").run(input.userId)
      this.db.prepare("DELETE FROM conversation_key_shares WHERE member_id=?").run(input.userId)
      this.db.prepare("DELETE FROM conversation_keys WHERE member_id=?").run(input.userId)
      this.db.prepare("DELETE FROM key_backups WHERE user_id=?").run(input.userId)
      this.db.prepare("DELETE FROM key_link_requests WHERE user_id=?").run(input.userId)
      this.db
        .prepare("UPDATE conversations SET rekey_needed=1 WHERE kind<>'direct' AND id IN (SELECT conversation_id FROM members WHERE user_id=?)")
        .run(input.userId)
      this.db
        .prepare("INSERT INTO account_keys(user_id,check_iv,check_ct,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(input.userId, input.checkIv, input.checkCiphertext, input.now, input.now)
      for (const slot of input.slots) this.insertKeySlot(slot)
      for (const item of input.vault) this.insertVaultItem(item)
      this.setUserPublicKey(input.userId, input.publicKey)
    })
  }
  listKeySlots(userId: string): KeySlotRow[] {
    return this.db.prepare("SELECT * FROM account_key_slots WHERE user_id=? ORDER BY created_at ASC").all(userId).map(mapKeySlot)
  }
  getKeySlot(id: string): KeySlotRow | null {
    const r = this.db.prepare("SELECT * FROM account_key_slots WHERE id=?").get(id)
    return r ? mapKeySlot(r) : null
  }
  private insertKeySlot(slot: KeySlotRow): void {
    this.db
      .prepare("INSERT INTO account_key_slots(id,user_id,kind,kdf,iv,ciphertext,label,stale,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(slot.id, slot.userId, slot.kind, slot.kdf, slot.iv, slot.ciphertext, slot.label ?? null, slot.stale ? 1 : 0, slot.createdAt, slot.updatedAt)
  }
  // A password or recovery slot replaces the previous one of its kind (a
  // stale password slot included); identity slots are kept per identity.
  putKeySlot(slot: KeySlotRow): void {
    this.transaction(() => {
      if (slot.kind === "password" || slot.kind === "recovery") {
        this.db.prepare("DELETE FROM account_key_slots WHERE user_id=? AND kind=?").run(slot.userId, slot.kind)
      } else if (slot.kind === "identity" && slot.label) {
        this.db.prepare("DELETE FROM account_key_slots WHERE user_id=? AND kind='identity' AND label=?").run(slot.userId, slot.label)
      }
      this.insertKeySlot(slot)
    })
  }
  deleteKeySlot(userId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM account_key_slots WHERE user_id=? AND id=?").run(userId, id).changes) > 0
  }
  // After an e-mail password reset the old password slot no longer matches the
  // login password. It is kept, marked stale, so the old password can still
  // unlock the keys once; the next unlocked device re-wraps it.
  markPasswordSlotsStale(userId: string, at: string): void {
    this.db.prepare("UPDATE account_key_slots SET stale=1, updated_at=? WHERE user_id=? AND kind='password'").run(at, userId)
  }
  setPasswordChangedAt(userId: string, at: string): void {
    this.db.prepare("UPDATE users SET password_changed_at=? WHERE id=?").run(at, userId)
  }
  getPasswordChangedAt(userId: string): string | null {
    const r = this.db.prepare("SELECT password_changed_at FROM users WHERE id=?").get(userId) as Record<string, unknown> | undefined
    return r && r.password_changed_at != null ? String(r.password_changed_at) : null
  }

  // --- account vault ---
  private insertVaultItem(item: VaultItemRow): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO account_vault(user_id,scope,item_id,conversation_id,key_id,iv,ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(item.userId, item.scope, item.itemId, item.conversationId ?? null, item.keyId ?? null, item.iv, item.ciphertext, item.createdAt)
    return Number(result.changes) > 0
  }
  // Vault items are write-once: the first sealed copy of a key wins, so a
  // buggy or hostile client can never overwrite a key that already works.
  putVaultItems(items: VaultItemRow[]): number {
    return this.transaction(() => {
      let added = 0
      for (const item of items) if (this.insertVaultItem(item)) added += 1
      return added
    })
  }
  listVaultItems(userId: string, opts: { scope?: string; conversationId?: string } = {}): VaultItemRow[] {
    if (opts.conversationId) {
      return this.db.prepare("SELECT * FROM account_vault WHERE user_id=? AND scope='cek' AND conversation_id=? ORDER BY created_at ASC").all(userId, opts.conversationId).map(mapVaultItem)
    }
    if (opts.scope) {
      return this.db.prepare("SELECT * FROM account_vault WHERE user_id=? AND scope=? ORDER BY created_at ASC").all(userId, opts.scope).map(mapVaultItem)
    }
    return this.db.prepare("SELECT * FROM account_vault WHERE user_id=? ORDER BY created_at ASC").all(userId).map(mapVaultItem)
  }
  countVaultItems(userId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM account_vault WHERE user_id=?").get(userId) as Record<string, unknown>
    return Number(r?.n ?? 0)
  }

  // --- conversation key epochs and shares ---
  getConversationKeyState(conversationId: string): { currentKeyId: string | null; rekeyNeeded: boolean } {
    const r = this.db.prepare("SELECT current_key_id, rekey_needed FROM conversations WHERE id=?").get(conversationId) as Record<string, unknown> | undefined
    return { currentKeyId: r && r.current_key_id != null ? String(r.current_key_id) : null, rekeyNeeded: Boolean(r && Number(r.rekey_needed) === 1) }
  }
  markRekeyNeeded(conversationId: string): void {
    this.db.prepare("UPDATE conversations SET rekey_needed=1 WHERE id=? AND kind<>'direct'").run(conversationId)
  }
  listKeyEpochs(conversationId: string): KeyEpochRow[] {
    return this.db.prepare("SELECT * FROM conversation_key_epochs WHERE conversation_id=? ORDER BY created_at ASC, key_id ASC").all(conversationId).map(mapKeyEpoch)
  }
  getKeyEpoch(conversationId: string, keyId: string): KeyEpochRow | null {
    const r = this.db.prepare("SELECT * FROM conversation_key_epochs WHERE conversation_id=? AND key_id=?").get(conversationId, keyId)
    return r ? mapKeyEpoch(r) : null
  }
  // Compare-and-set on the conversation's current key: the epoch and its shares
  // land together, and only if nobody else switched the key in the meantime.
  createKeyEpoch(input: { conversationId: string; keyId: string; expectedCurrentKeyId: string | null; createdBy: string; createdAt: string; keyCheck: string | null; shares: KeyShareRow[] }): { ok: true } | { ok: false; currentKeyId: string | null } {
    return this.transaction(() => {
      const state = this.getConversationKeyState(input.conversationId)
      if (state.currentKeyId !== input.expectedCurrentKeyId) return { ok: false as const, currentKeyId: state.currentKeyId }
      if (this.getKeyEpoch(input.conversationId, input.keyId)) return { ok: false as const, currentKeyId: state.currentKeyId }
      this.db
        .prepare("INSERT INTO conversation_key_epochs(conversation_id,key_id,created_by,created_at,key_check) VALUES(?,?,?,?,?)")
        .run(input.conversationId, input.keyId, input.createdBy, input.createdAt, input.keyCheck)
      for (const share of input.shares) this.insertKeyShare(share)
      this.db.prepare("UPDATE conversations SET current_key_id=?, rekey_needed=0 WHERE id=?").run(input.keyId, input.conversationId)
      return { ok: true as const }
    })
  }
  // The first key system minted its key without an epoch row; older clients
  // still do. Their copies are recorded as the "legacy" epoch.
  ensureLegacyEpoch(conversationId: string, createdBy: string, at: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO conversation_key_epochs(conversation_id,key_id,created_by,created_at,key_check) VALUES(?,'legacy',?,?,NULL)")
      .run(conversationId, createdBy, at)
    this.db.prepare("UPDATE conversations SET current_key_id='legacy' WHERE id=? AND current_key_id IS NULL").run(conversationId)
  }
  private insertKeyShare(share: KeyShareRow): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO conversation_key_shares(conversation_id,key_id,member_id,ephemeral_public_key,iv,ciphertext,recipient_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(share.conversationId, share.keyId, share.memberId, share.ephemeralPublicKey, share.iv, share.ciphertext, share.recipientKey ?? null, share.createdBy, share.createdAt)
    return Number(result.changes) > 0
  }
  // Shares are insert-only: an existing copy is never replaced by someone else.
  // Only its recipient can drop it (when it does not open) to ask for a new one.
  putKeyShares(shares: KeyShareRow[]): KeyShareRow[] {
    return this.transaction(() => shares.filter((share) => this.insertKeyShare(share)))
  }
  replaceLegacyShare(share: KeyShareRow): void {
    this.db
      .prepare("INSERT OR REPLACE INTO conversation_key_shares(conversation_id,key_id,member_id,ephemeral_public_key,iv,ciphertext,recipient_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(share.conversationId, share.keyId, share.memberId, share.ephemeralPublicKey, share.iv, share.ciphertext, share.recipientKey ?? null, share.createdBy, share.createdAt)
  }
  getKeyShare(conversationId: string, keyId: string, memberId: string): KeyShareRow | null {
    const r = this.db.prepare("SELECT * FROM conversation_key_shares WHERE conversation_id=? AND key_id=? AND member_id=?").get(conversationId, keyId, memberId)
    return r ? mapKeyShare(r) : null
  }
  listKeySharesForMember(memberId: string, conversationId?: string): KeyShareRow[] {
    if (conversationId) {
      return this.db.prepare("SELECT * FROM conversation_key_shares WHERE member_id=? AND conversation_id=? ORDER BY created_at ASC").all(memberId, conversationId).map(mapKeyShare)
    }
    return this.db
      .prepare("SELECT s.* FROM conversation_key_shares s JOIN members m ON m.conversation_id=s.conversation_id AND m.user_id=s.member_id WHERE s.member_id=? ORDER BY s.created_at ASC")
      .all(memberId)
      .map(mapKeyShare)
  }
  listKeyShareMemberIds(conversationId: string, keyId: string): string[] {
    return this.db.prepare("SELECT member_id FROM conversation_key_shares WHERE conversation_id=? AND key_id=?").all(conversationId, keyId).map((r) => String(r.member_id))
  }
  deleteKeyShare(conversationId: string, keyId: string, memberId: string): boolean {
    return Number(this.db.prepare("DELETE FROM conversation_key_shares WHERE conversation_id=? AND key_id=? AND member_id=?").run(conversationId, keyId, memberId).changes) > 0
  }
  // A member whose identity key changed can no longer open shares wrapped for
  // the old one; those are removed so the others hand the keys over again.
  deleteStaleSharesForMember(memberId: string, currentPublicKey: string): number {
    return Number(
      this.db
        .prepare("DELETE FROM conversation_key_shares WHERE member_id=? AND recipient_key IS NOT NULL AND recipient_key<>?")
        .run(memberId, currentPublicKey).changes,
    )
  }
  // Whether this user can already read a key: a share for them or a sealed copy
  // in their own vault.
  userHoldsKey(userId: string, conversationId: string, keyId: string): boolean {
    const share = this.db.prepare("SELECT 1 AS ok FROM conversation_key_shares WHERE conversation_id=? AND key_id=? AND member_id=?").get(conversationId, keyId, userId)
    if (share) return true
    const vault = this.db.prepare("SELECT 1 AS ok FROM account_vault WHERE user_id=? AND scope='cek' AND conversation_id=? AND key_id=?").get(userId, conversationId, keyId)
    return Boolean(vault)
  }
  // Whether somebody besides this member can still read a key; a member's own
  // copy is never dropped when it is the last one anywhere.
  otherHolderExists(conversationId: string, keyId: string, exceptUserId: string): boolean {
    const share = this.db
      .prepare("SELECT 1 AS ok FROM conversation_key_shares s JOIN members m ON m.conversation_id=s.conversation_id AND m.user_id=s.member_id WHERE s.conversation_id=? AND s.key_id=? AND s.member_id<>? LIMIT 1")
      .get(conversationId, keyId, exceptUserId)
    if (share) return true
    const vault = this.db
      .prepare("SELECT 1 AS ok FROM account_vault v JOIN members m ON m.conversation_id=v.conversation_id AND m.user_id=v.user_id WHERE v.scope='cek' AND v.conversation_id=? AND v.key_id=? AND v.user_id<>? LIMIT 1")
      .get(conversationId, keyId, exceptUserId)
    return Boolean(vault)
  }

  // Keys other members still lack, limited to epochs this user can hand over.
  listMissingShares(userId: string, conversationId?: string, limit = 500): MissingShareRow[] {
    const scope = conversationId ? "e.conversation_id=?" : "e.conversation_id IN (SELECT conversation_id FROM members WHERE user_id=?)"
    const sql =
      "SELECT e.conversation_id AS conversation_id, e.key_id AS key_id, m.user_id AS member_id, u.public_key AS public_key " +
      "FROM conversation_key_epochs e " +
      "JOIN members m ON m.conversation_id=e.conversation_id " +
      "JOIN users u ON u.id=m.user_id " +
      "WHERE " + scope + " AND u.public_key IS NOT NULL AND u.public_key<>'' AND m.user_id<>? " +
      "AND EXISTS (SELECT 1 FROM members me WHERE me.conversation_id=e.conversation_id AND me.user_id=?) " +
      "AND NOT EXISTS (SELECT 1 FROM conversation_key_shares s WHERE s.conversation_id=e.conversation_id AND s.key_id=e.key_id AND s.member_id=m.user_id) " +
      "AND (EXISTS (SELECT 1 FROM conversation_key_shares s2 WHERE s2.conversation_id=e.conversation_id AND s2.key_id=e.key_id AND s2.member_id=?) " +
      "OR EXISTS (SELECT 1 FROM account_vault v WHERE v.user_id=? AND v.scope='cek' AND v.conversation_id=e.conversation_id AND v.key_id=e.key_id)) " +
      "ORDER BY e.created_at ASC LIMIT ?"
    const args = conversationId ? [conversationId, userId, userId, userId, userId, limit] : [userId, userId, userId, userId, userId, limit]
    return this.db.prepare(sql).all(...args).map((r) => ({ conversationId: String(r.conversation_id), keyId: String(r.key_id), memberId: String(r.member_id), publicKey: String(r.public_key) }))
  }

  // --- device link requests ---
  createLinkRequest(row: LinkRequestRow): void {
    this.db
      .prepare("INSERT INTO key_link_requests(id,user_id,session_id,ephemeral_public_key,label,status,response,approved_by_session,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.userId, row.sessionId, row.ephemeralPublicKey, row.label, row.status, row.response ?? null, row.approvedBySession ?? null, row.createdAt, row.expiresAt)
  }
  getLinkRequest(id: string): LinkRequestRow | null {
    const r = this.db.prepare("SELECT * FROM key_link_requests WHERE id=?").get(id)
    return r ? mapLinkRequest(r) : null
  }
  listPendingLinkRequests(userId: string, nowIso: string): LinkRequestRow[] {
    this.db.prepare("DELETE FROM key_link_requests WHERE expires_at<?").run(nowIso)
    return this.db.prepare("SELECT * FROM key_link_requests WHERE user_id=? AND status='pending' ORDER BY created_at DESC").all(userId).map(mapLinkRequest)
  }
  resolveLinkRequest(id: string, status: "approved" | "denied", response: string | null, bySession: string): boolean {
    return Number(
      this.db
        .prepare("UPDATE key_link_requests SET status=?, response=?, approved_by_session=? WHERE id=? AND status='pending'")
        .run(status, response, bySession, id).changes,
    ) > 0
  }
  deleteLinkRequest(id: string): void {
    this.db.prepare("DELETE FROM key_link_requests WHERE id=?").run(id)
  }

  // --- scheduled messages ---
  createScheduledMessage(row: ScheduledMessageRow): void {
    this.db
      .prepare("INSERT INTO scheduled_messages(id,conversation_id,sender_id,ciphertext,reply_to,silent,send_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.conversationId, row.senderId, row.ciphertext, row.replyTo, row.silent ? 1 : 0, row.sendAt, row.createdAt, row.updatedAt)
  }
  getScheduledMessage(id: string): ScheduledMessageRow | null {
    const r = this.db.prepare("SELECT * FROM scheduled_messages WHERE id=?").get(id)
    return r ? mapScheduled(r) : null
  }
  listScheduledMessages(conversationId: string, senderId: string): ScheduledMessageRow[] {
    return this.db.prepare("SELECT * FROM scheduled_messages WHERE conversation_id=? AND sender_id=? ORDER BY send_at ASC, id ASC").all(conversationId, senderId).map(mapScheduled)
  }
  countScheduledBySender(senderId: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db.prepare("SELECT conversation_id, COUNT(*) AS n FROM scheduled_messages WHERE sender_id=? GROUP BY conversation_id").all(senderId)) {
      out[String(r.conversation_id)] = Number(r.n)
    }
    return out
  }
  countScheduledInConversation(conversationId: string, senderId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE conversation_id=? AND sender_id=?").get(conversationId, senderId) as Record<string, unknown>
    return Number(r?.n ?? 0)
  }
  updateScheduledMessage(id: string, patch: { ciphertext?: string; sendAt?: string; silent?: boolean }, at: string): void {
    const current = this.getScheduledMessage(id)
    if (!current) return
    this.db
      .prepare("UPDATE scheduled_messages SET ciphertext=?, send_at=?, silent=?, updated_at=? WHERE id=?")
      .run(patch.ciphertext ?? current.ciphertext, patch.sendAt ?? current.sendAt, (patch.silent ?? current.silent) ? 1 : 0, at, id)
  }
  deleteScheduledMessage(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM scheduled_messages WHERE id=?").run(id).changes) > 0
  }
  listDueScheduledMessages(nowIso: string, limit = 200): ScheduledMessageRow[] {
    return this.db.prepare("SELECT * FROM scheduled_messages WHERE send_at<=? ORDER BY send_at ASC, id ASC LIMIT ?").all(nowIso, limit).map(mapScheduled)
  }
  nextScheduledAt(): string | null {
    const r = this.db.prepare("SELECT MIN(send_at) AS at FROM scheduled_messages").get() as Record<string, unknown> | undefined
    return r && r.at != null ? String(r.at) : null
  }

  // --- search corpus ---
  // Every message of every chat the user belongs to, newest first. The server
  // only ever hands out ciphertext; matching happens on the device.
  listMessagesForSearch(userId: string, opts: { before?: string | null; limit: number; conversationId?: string | null }): MessageRow[] {
    const limit = Math.max(1, Math.min(1000, opts.limit))
    const cursor = opts.before ? this.db.prepare("SELECT created_at, id FROM messages WHERE id=?").get(opts.before) as Record<string, unknown> | undefined : undefined
    const params: unknown[] = [userId]
    let where = "m.conversation_id IN (SELECT conversation_id FROM members WHERE user_id=?) AND m.deleted_at IS NULL AND m.ciphertext<>''"
    if (opts.conversationId) {
      where += " AND m.conversation_id=?"
      params.push(opts.conversationId)
    }
    if (cursor) {
      where += " AND (m.created_at, m.id) < (?, ?)"
      params.push(String(cursor.created_at), String(cursor.id))
    }
    params.push(limit)
    return this.db
      .prepare("SELECT m.id,m.conversation_id,m.sender_id,m.ciphertext,m.reply_to,m.created_at,m.edited_at,m.deleted_at,m.silent FROM messages m WHERE " + where + " ORDER BY m.created_at DESC, m.id DESC LIMIT ?")
      .all(...params)
      .map(mapMessage)
  }
  // A window of messages around one of them, for jumping to a search hit.
  listMessagesAround(conversationId: string, messageId: string, limit: number): { messages: MessageRow[]; hasOlder: boolean; hasNewer: boolean } | null {
    const target = this.db.prepare("SELECT created_at, id FROM messages WHERE id=? AND conversation_id=?").get(messageId, conversationId) as Record<string, unknown> | undefined
    if (!target) return null
    const half = Math.max(1, Math.floor(limit / 2))
    const older = this.db
      .prepare(MSG_COLS + " FROM messages WHERE conversation_id=? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(conversationId, String(target.created_at), String(target.id), half + 1)
      .map(mapMessage)
    const newer = this.db
      .prepare(MSG_COLS + " FROM messages WHERE conversation_id=? AND (created_at, id) >= (?, ?) ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(conversationId, String(target.created_at), String(target.id), half + 1)
      .map(mapMessage)
    const hasOlder = older.length > half
    const hasNewer = newer.length > half
    return { messages: older.slice(0, half).reverse().concat(newer.slice(0, half)), hasOlder, hasNewer }
  }
  listMessagesAfter(conversationId: string, afterId: string, limit: number): MessageRow[] {
    const cursor = this.db.prepare("SELECT created_at, id FROM messages WHERE id=? AND conversation_id=?").get(afterId, conversationId) as Record<string, unknown> | undefined
    if (!cursor) return []
    return this.db
      .prepare(MSG_COLS + " FROM messages WHERE conversation_id=? AND (created_at, id) > (?, ?) ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(conversationId, String(cursor.created_at), String(cursor.id), Math.max(1, Math.min(500, limit)))
      .map(mapMessage)
  }

  // --- bots ---
  createBot(input: { user: UserRow; ownerId: string; tokenHash: string; description: string | null; now: string }): void {
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO users(id,username,password_hash,display_name,created_at,public_key,is_bot,bot_owner_id) VALUES(?,?,?,?,?,?,1,?)")
        .run(input.user.id, input.user.username, input.user.passwordHash, input.user.displayName, input.user.createdAt, null, input.ownerId)
      this.db
        .prepare("INSERT INTO bots(id,owner_id,token_hash,description,allow_groups,commands,created_at,token_created_at) VALUES(?,?,?,?,1,'[]',?,?)")
        .run(input.user.id, input.ownerId, input.tokenHash, input.description, input.now, input.now)
    })
  }
  getBot(id: string): BotRow | null {
    const r = this.db.prepare("SELECT * FROM bots WHERE id=?").get(id)
    return r ? mapBot(r) : null
  }
  getBotByTokenHash(tokenHash: string): BotRow | null {
    const r = this.db.prepare("SELECT * FROM bots WHERE token_hash=?").get(tokenHash)
    return r ? mapBot(r) : null
  }
  listBotsForOwner(ownerId: string): BotRow[] {
    return this.db.prepare("SELECT * FROM bots WHERE owner_id=? ORDER BY created_at ASC").all(ownerId).map(mapBot)
  }
  countBotsForOwner(ownerId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM bots WHERE owner_id=?").get(ownerId) as Record<string, unknown>
    return Number(r?.n ?? 0)
  }
  updateBot(id: string, patch: { description?: string | null; allowGroups?: boolean; commands?: string; webhookUrl?: string | null; webhookSecret?: string | null; webhookFailures?: number; tokenHash?: string; tokenCreatedAt?: string; lastUsedAt?: string }): void {
    const current = this.getBot(id)
    if (!current) return
    this.db
      .prepare("UPDATE bots SET description=?, allow_groups=?, commands=?, webhook_url=?, webhook_secret=?, webhook_failures=?, token_hash=?, token_created_at=?, last_used_at=? WHERE id=?")
      .run(
        patch.description !== undefined ? patch.description : current.description,
        (patch.allowGroups ?? current.allowGroups) ? 1 : 0,
        patch.commands ?? current.commands,
        patch.webhookUrl !== undefined ? patch.webhookUrl : current.webhookUrl,
        patch.webhookSecret !== undefined ? patch.webhookSecret : current.webhookSecret,
        patch.webhookFailures ?? current.webhookFailures,
        patch.tokenHash ?? current.tokenHash,
        patch.tokenCreatedAt ?? current.tokenCreatedAt,
        patch.lastUsedAt ?? current.lastUsedAt,
        id,
      )
  }
  deleteBotRecords(id: string): void {
    this.db.prepare("DELETE FROM bot_updates WHERE bot_id=?").run(id)
    this.db.prepare("DELETE FROM bots WHERE id=?").run(id)
  }
  isBot(userId: string): boolean {
    const r = this.db.prepare("SELECT is_bot FROM users WHERE id=?").get(userId) as Record<string, unknown> | undefined
    return Boolean(r && Number(r.is_bot) === 1)
  }
  listBotMemberIds(conversationId: string): string[] {
    return this.db
      .prepare("SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND u.is_bot=1")
      .all(conversationId)
      .map((r) => String(r.user_id))
  }
  addBotUpdate(botId: string, payload: string, at: string): number {
    const result = this.db.prepare("INSERT INTO bot_updates(bot_id,payload,created_at) VALUES(?,?,?)").run(botId, payload, at)
    // A bot that never collects its updates must not grow the table forever.
    this.db
      .prepare("DELETE FROM bot_updates WHERE bot_id=? AND id <= (SELECT id FROM bot_updates WHERE bot_id=? ORDER BY id DESC LIMIT 1 OFFSET 1000)")
      .run(botId, botId)
    return Number(result.lastInsertRowid)
  }
  listBotUpdates(botId: string, offset: number, limit: number): Array<{ id: number; payload: string; createdAt: string }> {
    return this.db
      .prepare("SELECT id, payload, created_at FROM bot_updates WHERE bot_id=? AND id>=? ORDER BY id ASC LIMIT ?")
      .all(botId, offset, limit)
      .map((r) => ({ id: Number(r.id), payload: String(r.payload), createdAt: String(r.created_at) }))
  }
  ackBotUpdates(botId: string, belowId: number): void {
    this.db.prepare("DELETE FROM bot_updates WHERE bot_id=? AND id<?").run(botId, belowId)
  }
  pruneBotUpdates(olderThanIso: string): void {
    this.db.prepare("DELETE FROM bot_updates WHERE created_at<?").run(olderThanIso)
  }

  // --- web push subscriptions ---
  saveWebPushSubscription(row: WebPushSubscriptionRow): void {
    this.db
      .prepare(
        "INSERT INTO webpush_subscriptions(endpoint,user_id,p256dh,auth,device_id,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?) " +
          "ON CONFLICT(endpoint,user_id) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, device_id=excluded.device_id, last_seen_at=excluded.last_seen_at",
      )
      .run(row.endpoint, row.userId, row.p256dh, row.auth, row.deviceId, row.createdAt, row.lastSeenAt)
  }
  listWebPushSubscriptions(userId: string): WebPushSubscriptionRow[] {
    return this.db.prepare("SELECT * FROM webpush_subscriptions WHERE user_id=?").all(userId).map(mapWebPush)
  }
  deleteWebPushSubscription(endpoint: string, userId?: string): void {
    if (userId) this.db.prepare("DELETE FROM webpush_subscriptions WHERE endpoint=? AND user_id=?").run(endpoint, userId)
    else this.db.prepare("DELETE FROM webpush_subscriptions WHERE endpoint=?").run(endpoint)
  }
  // End of a visible session: the time others may see as "last seen".
  setLastSeen(userId: string, at: string): void {
    this.db.prepare("UPDATE users SET last_seen_at=?, last_active_at=? WHERE id=?").run(at, at, userId)
  }
  // Heartbeat while online; does not change what others see.
  touchActive(userIds: string[], at: string): void {
    if (userIds.length === 0) return
    const statement = this.db.prepare("UPDATE users SET last_active_at=? WHERE id=?")
    this.db.exec("BEGIN")
    try {
      for (const id of userIds) statement.run(at, id)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  getLastSeen(userId: string): string | null {
    const r = this.db.prepare("SELECT last_seen_at FROM users WHERE id=?").get(userId) as any
    return r && r.last_seen_at ? String(r.last_seen_at) : null
  }
  close(): void {
    this.db.close()
  }
  setUserPublicKey(id: string, publicKey: string): void {
    this.db.prepare("UPDATE users SET public_key=? WHERE id=?").run(publicKey, id)
  }
  getKeyBackup(userId: string): { salt: string; iv: string; ciphertext: string; iterations: number; publicKey: string; updatedAt: string } | null {
    const row = this.db
      .prepare("SELECT salt, iv, ciphertext, iterations, public_key, updated_at FROM key_backups WHERE user_id=?")
      .get(userId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      salt: String(row.salt ?? ""),
      iv: String(row.iv ?? ""),
      ciphertext: String(row.ciphertext ?? ""),
      iterations: Number(row.iterations ?? 0),
      publicKey: String(row.public_key ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    }
  }
  putKeyBackup(b: { userId: string; salt: string; iv: string; ciphertext: string; iterations: number; publicKey: string; updatedAt: string }): void {
    this.db
      .prepare(
        "INSERT INTO key_backups (user_id, salt, iv, ciphertext, iterations, public_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET salt=excluded.salt, iv=excluded.iv, ciphertext=excluded.ciphertext, " +
          "iterations=excluded.iterations, public_key=excluded.public_key, updated_at=excluded.updated_at",
      )
      .run(b.userId, b.salt, b.iv, b.ciphertext, b.iterations, b.publicKey, b.updatedAt)
  }
  putConversationKey(row: ConversationKeyRow): void {
    this.db
      .prepare("INSERT OR REPLACE INTO conversation_keys(conversation_id,member_id,ephemeral_public_key,iv,ciphertext,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(row.conversationId, row.memberId, row.ephemeralPublicKey, row.iv, row.ciphertext, row.createdBy, row.createdAt)
  }
  listConversationKeyMemberIds(conversationId: string): string[] {
    const rows = this.db
      .prepare("SELECT member_id FROM conversation_keys WHERE conversation_id=?")
      .all(conversationId) as Array<{ member_id: string }>
    return rows.map((r) => String(r.member_id))
  }
  deleteConversationKeyForMember(conversationId: string, memberId: string): void {
    this.db.prepare("DELETE FROM conversation_keys WHERE conversation_id=? AND member_id=?").run(conversationId, memberId)
  }
  getConversationKeyForMember(conversationId: string, memberId: string): ConversationKeyRow | null {
    const r = this.db
      .prepare("SELECT conversation_id,member_id,ephemeral_public_key,iv,ciphertext,created_by,created_at FROM conversation_keys WHERE conversation_id=? AND member_id=?")
      .get(conversationId, memberId)
    return r ? mapConversationKey(r) : null
  }

  // --- users ---
  createUser(u: UserRow): void {
    this.db
      .prepare("INSERT INTO users(id,username,password_hash,display_name,created_at,public_key) VALUES(?,?,?,?,?,?)")
      .run(u.id, u.username, u.passwordHash, u.displayName, u.createdAt, u.publicKey ?? null)
  }
  getUserByUsername(username: string): UserRow | null {
    const r = this.db.prepare("SELECT * FROM users WHERE username=?").get(username)
    return r ? mapUser(r) : null
  }
  getUserById(id: string): UserRow | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id=?").get(id)
    return r ? mapUser(r) : null
  }
  updateUserDisplayName(id: string, displayName: string): void {
    this.db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName, id)
  }
  setUserAvatar(id: string, avatar: string | null): void {
    this.db.prepare("UPDATE users SET avatar=? WHERE id=?").run(avatar, id)
  }

  // --- sessions ---
  createSession(s: SessionRow): void {
    this.db
      .prepare("INSERT INTO sessions(id,token_hash,user_id,label,created_at,last_seen_at,expires_at,device_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(s.id, s.tokenHash, s.userId, s.label, s.createdAt, s.lastSeenAt, s.expiresAt, s.deviceId ?? null)
  }
  getSession(tokenHash: string): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(tokenHash)
    return r ? mapSession(r) : null
  }
  listSessionsForUser(userId: string): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC, created_at DESC")
      .all(userId)
      .map(mapSession)
  }
  touchSession(tokenHash: string, lastSeenAt: string): void {
    this.db.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?").run(lastSeenAt, tokenHash)
  }
  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash)
  }
  deleteSessionForUser(userId: string, sessionId: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE user_id=? AND id=?").run(userId, sessionId)
    return Number(result.changes) > 0
  }
  deleteOtherSessions(userId: string, keepSessionId: string): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(userId, keepSessionId)
    return Number(result.changes)
  }

  // --- conversations & members ---
// session device helpers
  deleteSessionsForDevice(userId: string, deviceId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id=? AND device_id=?").run(userId, deviceId)
  }
  findSessionByDevice(userId: string, deviceId: string): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE user_id=? AND device_id=? LIMIT 1").get(userId, deviceId)
    return r ? mapSession(r) : null
  }
  createConversation(c: ConversationRow): void {
    this.db
      .prepare("INSERT INTO conversations(id,kind,title,created_by,created_at) VALUES(?,?,?,?,?)")
      .run(c.id, c.kind, c.title, c.createdBy, c.createdAt)
  }
  updateConversationTitle(id: string, title: string | null): void {
    this.db.prepare("UPDATE conversations SET title=? WHERE id=?").run(title, id)
  }
  setConversationAvatar(id: string, avatar: string | null): void {
    this.db.prepare("UPDATE conversations SET avatar=? WHERE id=?").run(avatar, id)
  }
  setConversationSelf(id: string): void {
    this.db.prepare("UPDATE conversations SET is_self=1 WHERE id=?").run(id)
  }
  findSelfConversation(userId: string): ConversationRow | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE is_self=1 AND created_by=? LIMIT 1").get(userId)
    return r ? mapConversation(r) : null
  }
  findDirectConversationBetween(a: string, b: string): ConversationRow | null {
    const r = this.db.prepare("SELECT c.* FROM conversations c WHERE c.kind='direct' AND (c.is_self IS NULL OR c.is_self=0) AND (SELECT COUNT(*) FROM members m WHERE m.conversation_id=c.id)=2 AND EXISTS(SELECT 1 FROM members m1 WHERE m1.conversation_id=c.id AND m1.user_id=?) AND EXISTS(SELECT 1 FROM members m2 WHERE m2.conversation_id=c.id AND m2.user_id=?) LIMIT 1").get(a, b)
    return r ? mapConversation(r) : null
  }
  createFriendRequest(row: FriendRequestRow): void {
    this.db.prepare("INSERT OR REPLACE INTO friend_requests(id,from_user,to_user,status,created_at) VALUES(?,?,?,?,?)").run(row.id, row.fromUser, row.toUser, row.status, row.createdAt)
  }
  getFriendRequestById(id: string): FriendRequestRow | null {
    const r = this.db.prepare("SELECT * FROM friend_requests WHERE id=?").get(id)
    return r ? mapFriendRequest(r) : null
  }
  getFriendRequestPair(fromUser: string, toUser: string): FriendRequestRow | null {
    const r = this.db.prepare("SELECT * FROM friend_requests WHERE from_user=? AND to_user=?").get(fromUser, toUser)
    return r ? mapFriendRequest(r) : null
  }
  listIncomingFriendRequests(userId: string): FriendRequestRow[] {
    return this.db.prepare("SELECT * FROM friend_requests WHERE to_user=? AND status='pending' ORDER BY created_at DESC").all(userId).map(mapFriendRequest)
  }
  listOutgoingFriendRequests(userId: string): FriendRequestRow[] {
    return this.db.prepare("SELECT * FROM friend_requests WHERE from_user=? AND status='pending' ORDER BY created_at DESC").all(userId).map(mapFriendRequest)
  }
  getUserSettings(userId: string): UserSettingsRow {
    const r = this.db.prepare("SELECT require_invite, ghost_mode, last_seen_policy, seen_time_policy, calls_policy FROM user_settings WHERE user_id=?").get(userId) as any
    return {
      requireInvite: r ? Number(r.require_invite) === 1 : false,
      ghostMode: r ? Number(r.ghost_mode) === 1 : false,
      lastSeenPolicy: normalisePolicy(r ? r.last_seen_policy : null),
      // A row without its own value follows the online-status choice.
      seenTimePolicy: normalisePolicy(r ? (r.seen_time_policy ?? r.last_seen_policy) : null),
      callsPolicy: normalisePolicy(r ? r.calls_policy : null),
    }
  }
  setUserSettings(userId: string, settings: UserSettingsRow): void {
    this.db
      .prepare("INSERT OR REPLACE INTO user_settings(user_id,require_invite,ghost_mode,last_seen_policy,seen_time_policy,calls_policy) VALUES(?,?,?,?,?,?)")
      .run(userId, settings.requireInvite ? 1 : 0, settings.ghostMode ? 1 : 0, settings.lastSeenPolicy, settings.seenTimePolicy, settings.callsPolicy)
  }
  listPrivacyExceptions(userId: string): PrivacyExceptionRow[] {
    return this.db
      .prepare("SELECT target_id, scope, mode FROM privacy_exceptions WHERE user_id=?")
      .all(userId)
      .map((r: Record<string, any>) => ({ targetId: r.target_id as string, scope: r.scope as PrivacyScope, mode: r.mode as PrivacyMode }))
  }
  getPrivacyException(userId: string, targetId: string, scope: PrivacyScope): PrivacyMode | null {
    const r = this.db.prepare("SELECT mode FROM privacy_exceptions WHERE user_id=? AND target_id=? AND scope=?").get(userId, targetId, scope) as any
    return r ? (r.mode as PrivacyMode) : null
  }
  setPrivacyException(userId: string, targetId: string, scope: PrivacyScope, mode: PrivacyMode | null): void {
    if (mode === null) {
      this.db.prepare("DELETE FROM privacy_exceptions WHERE user_id=? AND target_id=? AND scope=?").run(userId, targetId, scope)
      return
    }
    this.db.prepare("INSERT OR REPLACE INTO privacy_exceptions(user_id,target_id,scope,mode) VALUES(?,?,?,?)").run(userId, targetId, scope, mode)
  }
  // A contact is someone this user shares a one-to-one chat with.
  isDirectContact(userId: string, otherId: string): boolean {
    const r = this.db
      .prepare("SELECT 1 AS ok FROM conversations c JOIN members m ON m.conversation_id=c.id AND m.user_id=? JOIN members m2 ON m2.conversation_id=c.id AND m2.user_id=? WHERE c.kind='direct' AND (c.is_self IS NULL OR c.is_self=0) LIMIT 1")
      .get(userId, otherId)
    return Boolean(r)
  }
  isGhostMode(userId: string): boolean {
    const r = this.db.prepare("SELECT ghost_mode FROM user_settings WHERE user_id=?").get(userId) as any
    return r ? Number(r.ghost_mode) === 1 : false
  }
  createGroupInvite(row: GroupInviteRow): void {
    this.db.prepare("INSERT OR REPLACE INTO group_invites(id,conversation_id,from_user,to_user,created_at) VALUES(?,?,?,?,?)").run(row.id, row.conversationId, row.fromUser, row.toUser, row.createdAt)
  }
  getGroupInviteById(id: string): GroupInviteRow | null {
    const r = this.db.prepare("SELECT * FROM group_invites WHERE id=?").get(id) as any
    return r ? { id: r.id, conversationId: r.conversation_id, fromUser: r.from_user, toUser: r.to_user, createdAt: r.created_at } : null
  }
  getGroupInvitePair(conversationId: string, toUser: string): GroupInviteRow | null {
    const r = this.db.prepare("SELECT * FROM group_invites WHERE conversation_id=? AND to_user=?").get(conversationId, toUser) as any
    return r ? { id: r.id, conversationId: r.conversation_id, fromUser: r.from_user, toUser: r.to_user, createdAt: r.created_at } : null
  }
  listGroupInvitesForUser(userId: string): GroupInviteRow[] {
    const rows = this.db.prepare("SELECT * FROM group_invites WHERE to_user=? ORDER BY created_at DESC").all(userId) as any[]
    return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, fromUser: r.from_user, toUser: r.to_user, createdAt: r.created_at }))
  }
  deleteGroupInvite(id: string): void {
    this.db.prepare("DELETE FROM group_invites WHERE id=?").run(id)
  }
  setFriendRequestStatus(id: string, status: string): void {
    this.db.prepare("UPDATE friend_requests SET status=? WHERE id=?").run(status, id)
  }
  deleteFriendRequest(id: string): void {
    this.db.prepare("DELETE FROM friend_requests WHERE id=?").run(id)
  }
  listComments(conversationId: string, parentId: string): MessageRow[] {
    return this.db.prepare(MSG_COLS + " FROM messages WHERE conversation_id=? AND reply_to=? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC").all(conversationId, parentId).map(mapMessage)
  }
  createSticker(row: StickerRow): void {
    this.db.prepare("INSERT INTO stickers(id,owner_id,data,created_at) VALUES(?,?,?,?)").run(row.id, row.ownerId, row.data, row.createdAt)
  }
  listStickers(ownerId: string): StickerRow[] {
    return this.db.prepare("SELECT * FROM stickers WHERE owner_id=? ORDER BY created_at DESC").all(ownerId).map(mapSticker)
  }
  getSticker(id: string): StickerRow | null {
    const r = this.db.prepare("SELECT * FROM stickers WHERE id=?").get(id)
    return r ? mapSticker(r) : null
  }
  deleteSticker(id: string): void {
    this.db.prepare("DELETE FROM stickers WHERE id=?").run(id)
  }
  stickerBytesForUser(ownerId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(LENGTH(data)),0) AS total FROM stickers WHERE owner_id=?").get(ownerId) as Record<string, any>
    return Number(r?.total ?? 0)
  }
  getConversation(id: string): ConversationRow | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id)
    return r ? mapConversation(r) : null
  }
  addMember(m: MemberRow): void {
    this.db
      .prepare("INSERT OR IGNORE INTO members(conversation_id,user_id,role,joined_at) VALUES(?,?,?,?)")
      .run(m.conversationId, m.userId, m.role, m.joinedAt)
  }
  getMember(conversationId: string, userId: string): MemberRow | null {
    const r = this.db
      .prepare("SELECT * FROM members WHERE conversation_id=? AND user_id=?")
      .get(conversationId, userId)
    return r ? mapMember(r) : null
  }
  listMembers(conversationId: string): MemberRow[] {
    return this.db.prepare("SELECT * FROM members WHERE conversation_id=?").all(conversationId).map(mapMember)
  }
  listConversationIdsForUser(userId: string): string[] {
    return this.db
      .prepare("SELECT conversation_id FROM members WHERE user_id=?")
      .all(userId)
      .map((row) => String(row.conversation_id))
  }
  listConversationsForUser(userId: string): ConversationRow[] {
    return this.db
      .prepare(
        "SELECT c.*, m.archived_at, m.muted_until FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE m.user_id=? ORDER BY c.created_at DESC",
      )
      .all(userId)
      .map(mapConversation)
  }
  setConversationTtl(conversationId: string, ttlSeconds: number | null): void {
    this.db.prepare("UPDATE conversations SET ttl_seconds=? WHERE id=?").run(ttlSeconds, conversationId)
  }
  listConversationsWithTtl(): Array<{ id: string; ttlSeconds: number }> {
    return this.db
      .prepare("SELECT id, ttl_seconds FROM conversations WHERE ttl_seconds IS NOT NULL AND ttl_seconds > 0")
      .all()
      .map((r: Record<string, any>) => ({ id: r.id as string, ttlSeconds: Number(r.ttl_seconds) }))
  }
  // Messages past their lifetime are removed outright - ciphertext, reactions,
  // receipts and pins go with them, and the attachments stored for that window
  // are reported back so their blobs can be deleted from disk too.
  purgeExpiredMessages(conversationId: string, cutoffIso: string): { messageIds: string[]; fileIds: string[] } {
    const messageIds = this.db
      .prepare("SELECT id FROM messages WHERE conversation_id=? AND created_at < ?")
      .all(conversationId, cutoffIso)
      .map((r: Record<string, any>) => r.id as string)
    const fileIds = this.db
      .prepare("SELECT id FROM file_assets WHERE conversation_id=? AND created_at < ?")
      .all(conversationId, cutoffIso)
      .map((r: Record<string, any>) => r.id as string)
    if (messageIds.length === 0 && fileIds.length === 0) return { messageIds, fileIds }
    const run = () => {
      for (const id of messageIds) {
        this.db.prepare("DELETE FROM reactions WHERE message_id=?").run(id)
        this.db.prepare("DELETE FROM pinned_messages WHERE message_id=?").run(id)
        this.db.prepare("DELETE FROM receipts WHERE message_id=?").run(id)
        this.db.prepare("DELETE FROM saved_messages WHERE message_id=?").run(id)
        this.db.prepare("DELETE FROM messages WHERE id=?").run(id)
      }
      for (const id of fileIds) {
        this.db.prepare("DELETE FROM replicas WHERE file_asset_id=?").run(id)
        this.db.prepare("DELETE FROM file_assets WHERE id=?").run(id)
      }
    }
    this.db.exec("BEGIN")
    try {
      run()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return { messageIds, fileIds }
  }
  setConversationArchived(conversationId: string, userId: string, archivedAt: string | null): void {
    this.db.prepare("UPDATE members SET archived_at=? WHERE conversation_id=? AND user_id=?").run(archivedAt, conversationId, userId)
  }
  setConversationMuted(conversationId: string, userId: string, mutedUntil: string | null): void {
    this.db.prepare("UPDATE members SET muted_until=? WHERE conversation_id=? AND user_id=?").run(mutedUntil, conversationId, userId)
  }
  createConversationFolder(row: ConversationFolderRow): void {
    this.db.prepare("INSERT INTO conversation_folders(id,user_id,name,created_at) VALUES(?,?,?,?)").run(row.id,row.userId,row.name,row.createdAt)
  }
  getConversationFolder(id: string): ConversationFolderRow | null {
    const r=this.db.prepare("SELECT id,user_id,name,created_at FROM conversation_folders WHERE id=?").get(id)
    if (!r) return null
    const conversationIds=this.db.prepare("SELECT conversation_id FROM folder_conversations WHERE folder_id=? ORDER BY conversation_id").all(id).map((v: Record<string, any>)=>v.conversation_id as string)
    return { id:r.id,userId:r.user_id,name:r.name,createdAt:r.created_at,conversationIds }
  }
  listConversationFolders(userId: string): ConversationFolderRow[] {
    return this.db.prepare("SELECT id,user_id,name,created_at FROM conversation_folders WHERE user_id=? ORDER BY created_at,name COLLATE NOCASE").all(userId).map((r: Record<string, any>)=>({ id:r.id,userId:r.user_id,name:r.name,createdAt:r.created_at,conversationIds:this.db.prepare("SELECT conversation_id FROM folder_conversations WHERE folder_id=? ORDER BY conversation_id").all(r.id).map((v: Record<string, any>)=>v.conversation_id as string) }))
  }
  deleteConversationFolder(id: string): void { this.db.prepare("DELETE FROM folder_conversations WHERE folder_id=?").run(id); this.db.prepare("DELETE FROM conversation_folders WHERE id=?").run(id) }
  setFolderConversationMembership(folderId: string, conversationId: string, active: boolean): void { if (active) this.db.prepare("INSERT OR IGNORE INTO folder_conversations(folder_id,conversation_id) VALUES(?,?)").run(folderId,conversationId); else this.db.prepare("DELETE FROM folder_conversations WHERE folder_id=? AND conversation_id=?").run(folderId,conversationId) }
  saveMessageForUser(userId: string,messageId: string,savedAt: string): void { this.db.prepare("INSERT OR REPLACE INTO saved_messages(user_id,message_id,saved_at) VALUES(?,?,?)").run(userId,messageId,savedAt) }
  unsaveMessageForUser(userId: string,messageId: string): void { this.db.prepare("DELETE FROM saved_messages WHERE user_id=? AND message_id=?").run(userId,messageId) }
  listSavedMessagesForUser(userId: string): SavedMessageRow[] { return this.db.prepare("SELECT m.*,s.saved_at FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE s.user_id=? AND m.deleted_at IS NULL ORDER BY s.saved_at DESC").all(userId).map((r: Record<string, any>)=>({userId,message:mapMessage(r),savedAt:r.saved_at})) }
  setMemberRole(conversationId: string, userId: string, role: MemberRole): void {
    this.db.prepare("UPDATE members SET role=? WHERE conversation_id=? AND user_id=?").run(role, conversationId, userId)
  }
  pinMessage(row: PinnedMessageRow): void {
    this.db.prepare("INSERT OR REPLACE INTO pinned_messages(conversation_id,message_id,pinned_by,pinned_at) VALUES(?,?,?,?)").run(row.conversationId, row.messageId, row.pinnedBy, row.pinnedAt)
  }
  unpinMessage(conversationId: string, messageId: string): void {
    this.db.prepare("DELETE FROM pinned_messages WHERE conversation_id=? AND message_id=?").run(conversationId, messageId)
  }
  listPinnedMessages(conversationId: string): PinnedMessageRow[] {
    return this.db.prepare("SELECT conversation_id,message_id,pinned_by,pinned_at FROM pinned_messages WHERE conversation_id=? ORDER BY pinned_at DESC").all(conversationId).map((r: Record<string, any>) => ({ conversationId: r.conversation_id, messageId: r.message_id, pinnedBy: r.pinned_by, pinnedAt: r.pinned_at }))
  }
  getConversationDraft(conversationId: string, userId: string): ConversationDraftRow | null {
    const row = this.db.prepare("SELECT conversation_id,user_id,ciphertext,updated_at FROM conversation_drafts WHERE conversation_id=? AND user_id=?").get(conversationId, userId)
    return row ? { conversationId: row.conversation_id, userId: row.user_id, ciphertext: row.ciphertext, updatedAt: row.updated_at } : null
  }
  saveConversationDraft(row: ConversationDraftRow): void {
    this.db.prepare("INSERT INTO conversation_drafts(conversation_id,user_id,ciphertext,updated_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at").run(row.conversationId, row.userId, row.ciphertext, row.updatedAt)
  }
  clearConversationDraft(conversationId: string, userId: string): void {
    this.db.prepare("DELETE FROM conversation_drafts WHERE conversation_id=? AND user_id=?").run(conversationId, userId)
  }

  // --- messages ---
// conversation, user, and invite helpers
  removeMember(conversationId: string, userId: string): void {
    this.db.prepare("DELETE FROM members WHERE conversation_id=? AND user_id=?").run(conversationId, userId)
  }
  deleteUserAccount(userId: string): { conversationsDeleted: number; assetIds: string[] } {
    const assetIds = this.db
      .prepare("SELECT id FROM file_assets WHERE owner_id=?")
      .all(userId)
      .map((r: Record<string, any>) => String(r.id))
    const convIds = this.db
      .prepare("SELECT conversation_id FROM members WHERE user_id=?")
      .all(userId)
      .map((r: Record<string, any>) => String(r.conversation_id))
    const soloIds: string[] = []
    for (const cid of convIds) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM members WHERE conversation_id=? AND user_id<>?")
        .get(cid, userId) as Record<string, any> | undefined
      if (!row || Number(row.n) === 0) soloIds.push(cid)
    }
    const singleParam = [
      "DELETE FROM poll_votes WHERE message_id IN (SELECT id FROM messages WHERE sender_id=?)",
      "DELETE FROM polls WHERE message_id IN (SELECT id FROM messages WHERE sender_id=?)",
      "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE sender_id=?)",
      "DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE sender_id=?)",
      "DELETE FROM saved_messages WHERE message_id IN (SELECT id FROM messages WHERE sender_id=?)",
      "DELETE FROM pinned_messages WHERE message_id IN (SELECT id FROM messages WHERE sender_id=?)",
      "DELETE FROM messages WHERE sender_id=?",
      "DELETE FROM poll_votes WHERE user_id=?",
      "DELETE FROM polls WHERE creator_id=?",
      "DELETE FROM reactions WHERE user_id=?",
      "DELETE FROM receipts WHERE user_id=?",
      "DELETE FROM saved_messages WHERE user_id=?",
      "DELETE FROM pinned_messages WHERE pinned_by=?",
      "DELETE FROM conversation_drafts WHERE user_id=?",
      "DELETE FROM folder_conversations WHERE folder_id IN (SELECT id FROM conversation_folders WHERE user_id=?)",
      "DELETE FROM conversation_folders WHERE user_id=?",
      "DELETE FROM conversation_keys WHERE member_id=?",
      "DELETE FROM conversation_keys WHERE created_by=?",
      "DELETE FROM replicas WHERE file_asset_id IN (SELECT id FROM file_assets WHERE owner_id=?)",
      "DELETE FROM file_assets WHERE owner_id=?",
      "DELETE FROM stickers WHERE owner_id=?",
      "DELETE FROM invites WHERE created_by=?",
      "DELETE FROM key_backups WHERE user_id=?",
      "DELETE FROM account_keys WHERE user_id=?",
      "DELETE FROM account_key_slots WHERE user_id=?",
      "DELETE FROM account_vault WHERE user_id=?",
      "DELETE FROM conversation_key_shares WHERE member_id=?",
      "DELETE FROM key_link_requests WHERE user_id=?",
      "DELETE FROM scheduled_messages WHERE sender_id=?",
      "DELETE FROM webpush_subscriptions WHERE user_id=?",
      "DELETE FROM bot_updates WHERE bot_id=?",
      "DELETE FROM bots WHERE id=?",
      "DELETE FROM user_settings WHERE user_id=?",
      "DELETE FROM privacy_exceptions WHERE user_id=?",
      "DELETE FROM privacy_exceptions WHERE target_id=?",
      "DELETE FROM email_codes WHERE user_id=?",
      "DELETE FROM push_endpoints WHERE user_id=?",
      "DELETE FROM sessions WHERE user_id=?",
      "DELETE FROM members WHERE user_id=?",
      "DELETE FROM users WHERE id=?",
    ]
    const dualParam = [
      "DELETE FROM friend_requests WHERE from_user=? OR to_user=?",
      "DELETE FROM group_invites WHERE from_user=? OR to_user=?",
    ]
    let conversationsDeleted = 0
    this.db.exec("BEGIN")
    try {
      for (const cid of soloIds) {
        this.deleteConversation(cid)
        conversationsDeleted += 1
      }
      for (const sql of singleParam) this.db.prepare(sql).run(userId)
      for (const sql of dualParam) this.db.prepare(sql).run(userId, userId)
      this.db.exec("COMMIT")
    } catch (err) {
      try { this.db.exec("ROLLBACK") } catch {}
      throw err
    }
    return { conversationsDeleted, assetIds }
  }
  deleteConversation(id: string): void {
    for (const sql of [
      "DELETE FROM poll_votes WHERE message_id IN (SELECT message_id FROM polls WHERE conversation_id=?)",
      "DELETE FROM polls WHERE conversation_id=?",
      "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)",
      "DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)",
      "DELETE FROM saved_messages WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)",
      "DELETE FROM pinned_messages WHERE conversation_id=?",
      "DELETE FROM conversation_drafts WHERE conversation_id=?",
      "DELETE FROM file_assets WHERE conversation_id=?",
      "DELETE FROM conversation_keys WHERE conversation_id=?",
      "DELETE FROM conversation_key_shares WHERE conversation_id=?",
      "DELETE FROM conversation_key_epochs WHERE conversation_id=?",
      "DELETE FROM account_vault WHERE conversation_id=?",
      "DELETE FROM scheduled_messages WHERE conversation_id=?",
      "DELETE FROM messages WHERE conversation_id=?",
      "DELETE FROM members WHERE conversation_id=?",
      "DELETE FROM folder_conversations WHERE conversation_id=?",
      "DELETE FROM conversations WHERE id=?",
    ]) {
      this.db.prepare(sql).run(id)
    }
  }
  listDirectPeers(userId: string): Array<{ conversationId: string; user: UserRow }> {
    return this.db
      .prepare("SELECT c.id AS conversation_id, u.id AS id, u.username AS username, u.password_hash AS password_hash, u.display_name AS display_name, u.created_at AS created_at, u.public_key AS public_key, u.avatar AS avatar, u.is_bot AS is_bot, u.bot_owner_id AS bot_owner_id FROM conversations c JOIN members m ON m.conversation_id=c.id AND m.user_id=? JOIN members m2 ON m2.conversation_id=c.id AND m2.user_id<>? JOIN users u ON u.id=m2.user_id WHERE c.kind='direct' AND (c.is_self IS NULL OR c.is_self=0) ORDER BY u.display_name COLLATE NOCASE")
      .all(userId, userId)
      .map((r: Record<string, any>) => ({ conversationId: r.conversation_id, user: mapUser(r) }))
  }
  getDirectPeer(conversationId: string, userId: string): UserRow | null {
    const r = this.db.prepare("SELECT u.* FROM members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id<>? LIMIT 1").get(conversationId, userId)
    return r ? mapUser(r) : null
  }
  searchUsers(query: string, excludeUserId: string, limit = 10): UserRow[] {
    // % and _ are wildcards in LIKE; left unescaped, a query of "%%" lists
    // every account on the server.
    const like = "%" + query.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%"
    return this.db.prepare("SELECT * FROM users WHERE id<>? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY display_name COLLATE NOCASE LIMIT ?").all(excludeUserId, like, like, limit).map(mapUser)
  }
  createInvite(row: InviteRow): void {
    this.db.prepare("INSERT OR REPLACE INTO invites(code,conversation_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)").run(inviteCodeHash(row.code), row.conversationId, row.createdBy, row.createdAt, row.expiresAt ?? null)
  }
  getInvite(code: string): InviteRow | null {
    const r = this.db.prepare("SELECT code,conversation_id,created_by,created_at,expires_at FROM invites WHERE code=?").get(inviteCodeHash(code))
    return r ? { code: code, conversationId: r.conversation_id, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at ?? null } : null
  }
  deleteInvite(code: string): void {
    this.db.prepare("DELETE FROM invites WHERE code=?").run(inviteCodeHash(code))
  }
  findInviteForConversation(conversationId: string): InviteRow | null {
    const r = this.db.prepare("SELECT code,conversation_id,created_by,created_at FROM invites WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1").get(conversationId)
    return r ? { code: r.code, conversationId: r.conversation_id, createdBy: r.created_by, createdAt: r.created_at } : null
  }
  createMessage(m: MessageRow): MessageRow {
    this.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,sender_id,ciphertext,reply_to,created_at,silent) VALUES(?,?,?,?,?,?,?)",
      )
      .run(m.id, m.conversationId, m.senderId, m.ciphertext, m.replyTo, m.createdAt, m.silent ? 1 : 0)
    return m
  }
  listMessages(conversationId: string, opts: { limit?: number; before?: string | null } | number = {}): MessageRow[] {
    const o = typeof opts === "number" ? { limit: opts, before: null } : opts
    const limit = Math.max(1, Math.min(500, o.limit ?? 200))
    const before = o.before ?? null
    const rows = before
      ? this.db
          .prepare(
            MSG_COLS + " FROM messages WHERE conversation_id=? AND (created_at, id) < (SELECT created_at, id FROM messages WHERE id=?) ORDER BY created_at DESC, id DESC LIMIT ?",
          )
          .all(conversationId, before, limit)
      : this.db
          .prepare(MSG_COLS + " FROM messages WHERE conversation_id=? ORDER BY created_at DESC, id DESC LIMIT ?")
          .all(conversationId, limit)
    return rows.map(mapMessage).reverse()
  }

  getMessage(id: string): MessageRow | null {
    const r = this.db.prepare(MSG_COLS + " FROM messages WHERE id=?").get(id)
    return r ? mapMessage(r as Record<string, any>) : null
  }
  editMessage(id: string, ciphertext: string, editedAt: string): void {
    this.db.prepare("UPDATE messages SET ciphertext=?, edited_at=? WHERE id=?").run(ciphertext, editedAt, id)
  }
  softDeleteMessage(id: string, deletedAt: string): void {
    this.db.prepare("UPDATE messages SET ciphertext=?, deleted_at=? WHERE id=?").run("", deletedAt, id)
    this.db.prepare("DELETE FROM pinned_messages WHERE message_id=?").run(id)
    this.db.prepare("DELETE FROM saved_messages WHERE message_id=?").run(id)
    this.db.prepare("DELETE FROM poll_votes WHERE message_id=?").run(id)
    this.db.prepare("DELETE FROM polls WHERE message_id=?").run(id)
  }
  createPollMessage(message: MessageRow, poll: PollRow): MessageRow {
    this.db.exec("BEGIN")
    try {
      this.createMessage(message)
      this.createPoll(poll)
      this.db.exec("COMMIT")
      return message
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch { /* transaction was not started */ }
      throw error
    }
  }
  createPoll(poll: PollRow): void {
    this.db.prepare("INSERT INTO polls(message_id,conversation_id,creator_id,option_count,multiple_choice,quiz,closed_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(poll.messageId, poll.conversationId, poll.creatorId, poll.optionCount, poll.multipleChoice ? 1 : 0, poll.quiz ? 1 : 0, poll.closedAt, poll.createdAt)
  }
  getPoll(messageId: string): PollRow | null {
    const row = this.db.prepare("SELECT message_id,conversation_id,creator_id,option_count,multiple_choice,quiz,closed_at,created_at FROM polls WHERE message_id=?").get(messageId)
    return row ? mapPoll(row) : null
  }
  closePoll(messageId: string, closedAt: string): void {
    this.db.prepare("UPDATE polls SET closed_at=? WHERE message_id=? AND closed_at IS NULL").run(closedAt, messageId)
  }
  setPollVote(messageId: string, userId: string, optionIndexes: number[], updatedAt: string): void {
    this.db.prepare("INSERT INTO poll_votes(message_id,user_id,option_indexes,updated_at) VALUES(?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET option_indexes=excluded.option_indexes, updated_at=excluded.updated_at")
      .run(messageId, userId, JSON.stringify(optionIndexes), updatedAt)
  }
  getPollSnapshot(messageId: string, userId: string): PollSnapshot | null {
    const poll = this.getPoll(messageId)
    return poll ? this.toPollSnapshot(poll, userId) : null
  }
  listPollSnapshots(conversationId: string, userId: string): PollSnapshot[] {
    return this.db.prepare("SELECT message_id,conversation_id,creator_id,option_count,multiple_choice,quiz,closed_at,created_at FROM polls WHERE conversation_id=? ORDER BY created_at ASC")
      .all(conversationId)
      .map(mapPoll)
      .map((poll: PollRow) => this.toPollSnapshot(poll, userId))
  }
  private toPollSnapshot(poll: PollRow, userId: string): PollSnapshot {
    const votes = this.db.prepare("SELECT user_id,option_indexes FROM poll_votes WHERE message_id=?").all(poll.messageId)
    const optionCounts = Array.from({ length: poll.optionCount }, () => 0)
    let myOptionIndexes: number[] = []
    for (const vote of votes) {
      const indexes = parsePollIndexes(String(vote.option_indexes ?? ""), poll.optionCount)
      for (const index of indexes) optionCounts[index] += 1
      if (String(vote.user_id) === userId) myOptionIndexes = indexes
    }
    return { ...poll, optionCounts, totalVoters: votes.length, myOptionIndexes }
  }
  addReaction(messageId: string, userId: string, emoji: string, at: string): void {
    this.db
      .prepare("INSERT INTO reactions(message_id,user_id,emoji,at) VALUES(?,?,?,?) ON CONFLICT(message_id,user_id,emoji) DO NOTHING")
      .run(messageId, userId, emoji, at)
  }
  removeReaction(messageId: string, userId: string, emoji: string): void {
    this.db.prepare("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").run(messageId, userId, emoji)
  }
  listReactions(conversationId: string): ReactionRow[] {
    return this.db
      .prepare("SELECT r.message_id AS mid, r.user_id AS uid, r.emoji AS emoji, r.at AS at FROM reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=? ORDER BY r.at ASC")
      .all(conversationId)
      .map((x: Record<string, any>) => ({ messageId: x.mid, userId: x.uid, emoji: x.emoji, at: x.at }))
  }
  // --- receipts ---
  listReceiptsForConversation(conversationId: string) {
    return this.db
      .prepare(
        "SELECT r.message_id AS mid, r.user_id AS uid, r.state AS state, r.at AS at FROM receipts r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=? ORDER BY r.at ASC",
      )
      .all(conversationId)
      .map((x: any) => ({ messageId: x.mid, userId: x.uid, state: x.state, at: x.at }))
  }
  upsertReceipt(messageId: string, userId: string, state: string, at: string): void {
    this.db
      .prepare(
        "INSERT INTO receipts(message_id,user_id,state,at) VALUES(?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET state=excluded.state, at=excluded.at",
      )
      .run(messageId, userId, state, at)
  }

  // --- file assets & replicas ---
  createFileAsset(f: FileAssetRow): void {
    this.db
      .prepare(
        "INSERT INTO file_assets(id,conversation_id,owner_id,name,mime,size,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(f.id, f.conversationId, f.ownerId, f.name, f.mime, f.size, f.manifestJson, f.createdAt)
  }
  getFileAsset(id: string): FileAssetRow | null {
    const r = this.db.prepare("SELECT * FROM file_assets WHERE id=?").get(id)
    return r ? mapAsset(r) : null
  }
  createReplica(r: ReplicaRow): void {
    this.db
      .prepare("INSERT INTO replicas(id,file_asset_id,state,temp_expires_at,updated_at) VALUES(?,?,?,?,?)")
      .run(r.id, r.fileAssetId, r.state, r.tempExpiresAt, r.updatedAt)
  }
  getReplica(id: string): ReplicaRow | null {
    const r = this.db.prepare("SELECT * FROM replicas WHERE id=?").get(id)
    return r ? mapReplica(r) : null
  }
  getReplicaByAsset(fileAssetId: string): ReplicaRow | null {
    const r = this.db.prepare("SELECT * FROM replicas WHERE file_asset_id=?").get(fileAssetId)
    return r ? mapReplica(r) : null
  }
  saveReplica(r: ReplicaRow): void {
    this.db
      .prepare("UPDATE replicas SET state=?, temp_expires_at=?, updated_at=? WHERE id=?")
      .run(r.state, r.tempExpiresAt, r.updatedAt, r.id)
  }
  sumBackupBytesForOwner(ownerId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(fa.size),0) AS total FROM file_assets fa JOIN replicas r ON r.file_asset_id=fa.id WHERE fa.owner_id=? AND r.state=?")
      .get(ownerId, "TEMP_SERVER_BACKUP")
    return Number(row?.total ?? 0)
  }
  listAssetIdsForOwner(ownerId: string): string[] {
    const rows = this.db.prepare("SELECT id FROM file_assets WHERE owner_id=?").all(ownerId) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }
  listBackupAssetIdsForOwner(ownerId: string): string[] {
    const rows = this.db
      .prepare("SELECT fa.id FROM file_assets fa JOIN replicas r ON r.file_asset_id=fa.id WHERE fa.owner_id=? AND r.state=?")
      .all(ownerId, "TEMP_SERVER_BACKUP") as Array<{ id: string }>
    return rows.map((row) => row.id)
  }
  listFileAssetsByConversation(conversationId: string): FileAssetRow[] {
		return this.db
			.prepare("SELECT * FROM file_assets WHERE conversation_id=? ORDER BY created_at ASC")
			.all(conversationId)
			.map(mapAsset)
	}

	listBackupReplicas(): ReplicaRow[] {
    return this.db.prepare("SELECT * FROM replicas WHERE state='TEMP_SERVER_BACKUP'").all().map(mapReplica)
  }

  // --- account email, one-time codes and push endpoints ---
  getUserEmail(userId: string): { email: string | null; verifiedAt: string | null } {
    const row: any = this.db.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").get(userId)
    if (!row) return { email: null, verifiedAt: null }
    return {
      email: row.email != null ? String(row.email) : null,
      verifiedAt: row.email_verified_at != null ? String(row.email_verified_at) : null,
    }
  }

  findUserIdByEmail(email: string): string | null {
    const row: any = this.db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND email_verified_at IS NOT NULL")
      .get(email)
    return row ? String(row.id) : null
  }

  isEmailTaken(email: string, exceptUserId: string): boolean {
    const row: any = this.db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND email_verified_at IS NOT NULL AND id <> ?")
      .get(email, exceptUserId)
    return Boolean(row)
  }

  setUserEmail(userId: string, email: string | null, verifiedAt: string | null): void {
    this.db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run(email, verifiedAt, userId)
  }

  updateUserPassword(userId: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId)
  }

  deleteAllSessionsForUser(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId)
  }

  createEmailCode(row: EmailCodeRow): void {
    this.db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = ?").run(row.userId, row.purpose)
    this.db
      .prepare(
        "INSERT INTO email_codes (id, user_id, email, purpose, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.userId, row.email, row.purpose, row.codeHash, row.createdAt, row.expiresAt, row.attempts)
  }

  getEmailCode(userId: string, purpose: string): EmailCodeRow | null {
    const row: any = this.db
      .prepare("SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1")
      .get(userId, purpose)
    return row ? mapEmailCode(row) : null
  }

  bumpEmailCodeAttempts(id: string): number {
    this.db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(id)
    const row: any = this.db.prepare("SELECT attempts FROM email_codes WHERE id = ?").get(id)
    return row ? Number(row.attempts) : 0
  }

  deleteEmailCodes(userId: string, purpose: string): void {
    this.db.prepare("DELETE FROM email_codes WHERE user_id = ? AND purpose = ?").run(userId, purpose)
  }

  countEmailCodesSince(userId: string, purpose: string, sinceIso: string): number {
    const row: any = this.db
      .prepare("SELECT COUNT(*) AS n FROM email_codes WHERE user_id = ? AND purpose = ? AND created_at >= ?")
      .get(userId, purpose, sinceIso)
    return row ? Number(row.n) : 0
  }

  savePushEndpoint(row: PushEndpointRow): void {
    this.db
      .prepare(
        "INSERT INTO push_endpoints (endpoint, id, user_id, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, device_id = excluded.device_id, last_seen_at = excluded.last_seen_at",
      )
      .run(row.endpoint, row.id, row.userId, row.deviceId, row.createdAt, row.lastSeenAt)
  }

  listPushEndpoints(userId: string): PushEndpointRow[] {
    const rows = this.db.prepare("SELECT * FROM push_endpoints WHERE user_id = ? ORDER BY created_at ASC").all(userId) as any[]
    return rows.map(mapPushEndpoint)
  }

  deletePushEndpointByUrl(endpoint: string): void {
    this.db.prepare("DELETE FROM push_endpoints WHERE endpoint = ?").run(endpoint)
  }

  deletePushEndpointsForDevice(userId: string, deviceId: string): void {
    this.db.prepare("DELETE FROM push_endpoints WHERE user_id = ? AND device_id = ?").run(userId, deviceId)
  }

}

function mapUser(r: Record<string, any>): UserRow {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    displayName: r.display_name,
    createdAt: r.created_at,
    publicKey: r.public_key ?? null,
    avatar: r.avatar ?? null,
    isBot: Number(r.is_bot ?? 0) === 1,
    botOwnerId: r.bot_owner_id ?? null,
  }
}
function mapSession(r: Record<string, any>): SessionRow {
  return {
    id: r.id ?? r.token_hash,
    tokenHash: r.token_hash,
    userId: r.user_id,
    label: r.label ?? "Browser session",
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? r.created_at,
    expiresAt: r.expires_at,
    deviceId: r.device_id ?? null,
  }
}
function mapConversation(r: Record<string, any>): ConversationRow {
  return { id: r.id, kind: r.kind, title: r.title ?? null, createdBy: r.created_by, createdAt: r.created_at, avatar: r.avatar ?? null, isSelf: Boolean(r.is_self), archivedAt: r.archived_at ?? null, mutedUntil: r.muted_until ?? null, ttlSeconds: r.ttl_seconds ?? null }
}
function mapMember(r: Record<string, any>): MemberRow {
  return { conversationId: r.conversation_id, userId: r.user_id, role: r.role, joinedAt: r.joined_at, archivedAt: r.archived_at ?? null, mutedUntil: r.muted_until ?? null }
}
function mapFriendRequest(r: Record<string, any>): FriendRequestRow {
  return { id: r.id, fromUser: r.from_user, toUser: r.to_user, status: r.status, createdAt: r.created_at }
}
function mapSticker(r: Record<string, any>): StickerRow {
  return { id: r.id, ownerId: r.owner_id, data: r.data, createdAt: r.created_at }
}
const MSG_COLS = "SELECT id,conversation_id,sender_id,ciphertext,reply_to,created_at,edited_at,deleted_at,silent"
function mapMessage(r: Record<string, any>): MessageRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    ciphertext: r.ciphertext,
    replyTo: r.reply_to ?? null,
    createdAt: r.created_at,
    editedAt: r.edited_at ?? null,
    deletedAt: r.deleted_at ?? null,
    silent: Number(r.silent ?? 0) === 1,
  }
}
function mapPoll(r: Record<string, any>): PollRow {
  return {
    messageId: r.message_id,
    conversationId: r.conversation_id,
    creatorId: r.creator_id,
    optionCount: Number(r.option_count),
    multipleChoice: Boolean(r.multiple_choice),
    quiz: Boolean(r.quiz),
    closedAt: r.closed_at ?? null,
    createdAt: r.created_at,
  }
}
function parsePollIndexes(raw: string, optionCount: number): number[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const indexes = new Set<number>()
    for (const item of parsed) {
      const index = Number(item)
      if (Number.isInteger(index) && index >= 0 && index < optionCount) indexes.add(index)
    }
    return Array.from(indexes).sort((a, b) => a - b)
  } catch {
    return []
  }
}
function mapAsset(r: Record<string, any>): FileAssetRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    ownerId: r.owner_id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    manifestJson: r.manifest_json,
    createdAt: r.created_at,
  }
}
function mapReplica(r: Record<string, any>): ReplicaRow {
  return {
    id: r.id,
    fileAssetId: r.file_asset_id,
    state: r.state,
    tempExpiresAt: r.temp_expires_at ?? null,
    updatedAt: r.updated_at,
  }
}


export interface ConversationKeyRow {
  conversationId: string
  memberId: string
  ephemeralPublicKey: string
  iv: string
  ciphertext: string
  createdBy: string
  createdAt: string
}
function mapConversationKey(r: Record<string, any>): ConversationKeyRow {
  return {
    conversationId: r.conversation_id,
    memberId: r.member_id,
    ephemeralPublicKey: r.ephemeral_public_key,
    iv: r.iv,
    ciphertext: r.ciphertext,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}
