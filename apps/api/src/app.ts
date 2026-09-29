import type { IncomingMessage, ServerResponse } from "node:http"
import { Router, sendJson, readJson, sendBytes, type Ctx } from "./http.js"
import { BlobTooLargeError, blobByteLength, deleteBlob, freeDiskBytes, hasBlob, readBlob, saveBlobFromStream } from "./blobstore.js"
import { buildLinkPreview, fetchPreviewImage } from "./linkpreview.js"
import { HttpError } from "./errors.js"
import { DISK_RESERVE_BYTES, MAX_BLOB_BYTES, MAX_FILE_BYTES, STICKER_GIF_QUOTA_BYTES, TEMP_BACKUP_QUOTA_BYTES, USER_STORAGE_QUOTA_BYTES } from "./limits.js"
import { Store, type KeySlotRow, type MessageRow, type ReplicaRow, type MemberRow, type PollRow, type PollSnapshot, type ConversationRow, type FriendRequestRow, type PrivacyPolicy, type PrivacyScope } from "./store.js"
import { EventBus } from "./eventbus.js"
import { CallRegistry, iceServersFromEnv } from "./calls.js"
import * as authmod from "./auth.js"
import { createHash, randomInt, timingSafeEqual } from "node:crypto"
import { hashPassword, verifyPassword } from "@frontierx/crypto"
import { createMailer, isValidEmail, MailerDisabledError, normalizeEmail, passwordResetEmail, verificationEmail } from "./mailer.js"
import { FCM_PREFIX, isAcceptableEndpoint, PushSender } from "./push.js"
import { isNewerThan, isPlatform, latestRelease } from "./releases.js"
import { assertCurrentKey, KeyChangedError, parseAccountBundle, registerKeyRoutes, b64Field, slotFromBody } from "./keysv2.js"
import { announceBotRemoved, BotHub, dropBotDirectChats, registerBotRoutes } from "./bots.js"
import { WebPushSender } from "./webpush.js"
import { newId, SystemClock } from "@frontierx/shared"
import { FileLifecycle, LifecycleError, type ReplicaRecord } from "@frontierx/domain"
import type { ConversationKind, MessageEnvelope, WsEvent, MemberRole, PollSummary, PollRealtimeUpdate } from "@frontierx/protocol"

// Assembles the store, event bus, file lifecycle, and route table into a single
// request listener. createApp() takes no port and no side effects beyond the
// database, so tests spin up as many isolated in-memory apps as they need.

export interface App {
  listener: (req: IncomingMessage, res: ServerResponse) => void
  store: Store
  bus: EventBus
  lifecycle: FileLifecycle
  // Heartbeat for the "last seen" time; server.ts calls it every minute.
  refreshLastSeen: () => void
  // Sends scheduled messages whose time has come; server.ts calls it every few
  // seconds. Returns how many were delivered.
  deliverDueScheduled: (now?: number) => number
  bots: BotHub
}

export interface CreateAppOptions {
  dbPath?: string
  limits?: {
    maxFileBytes?: number
    maxBlobBytes?: number
    tempBackupQuotaBytes?: number
    userStorageQuotaBytes?: number
    diskReserveBytes?: number
  }
}

export function createApp(options: CreateAppOptions = {}): App {
  const store = new Store(options.dbPath ?? ":memory:")
  const bus = new EventBus()
  const calls = new CallRegistry()
  const startPresenceBroadcast = () => bus.setPresenceListener((userId, online) => {
    // The visit is recorded before anyone is told, so the offline event already
    // carries the new "last seen" time. Ghost mode records nothing, so turning
    // it off later does not reveal when the user was around meanwhile.
    if (!store.isGhostMode(userId)) {
      const now = new Date().toISOString()
      if (online) store.touchActive([userId], now)
      else store.setLastSeen(userId, now)
    }
    broadcastPresence(userId)
  })
  // Calls end when the user's last connection is gone. Stepping away from the
  // tab only hides the online status; the call carries on.
  const startCallCleanup = () => bus.setDisconnectListener((userId) => {
    for (const affected of calls.leaveAll(userId)) {
      const callMembers = store.listMembers(affected.conversationId).map((member) => member.userId)
      bus.publishToUsers(callMembers, { type: "call.left", conversationId: affected.conversationId, callId: affected.callId, userId } as WsEvent)
      if (affected.ended) bus.publishToUsers(callMembers, { type: "call.ended", conversationId: affected.conversationId, callId: affected.callId } as WsEvent)
    }
  })
  const lifecycle = new FileLifecycle(new SystemClock())
  const router = new Router()
  const limits = {
    maxFileBytes: options.limits?.maxFileBytes ?? MAX_FILE_BYTES,
    maxBlobBytes: options.limits?.maxBlobBytes ?? MAX_BLOB_BYTES,
    tempBackupQuotaBytes: options.limits?.tempBackupQuotaBytes ?? TEMP_BACKUP_QUOTA_BYTES,
    userStorageQuotaBytes: options.limits?.userStorageQuotaBytes ?? USER_STORAGE_QUOTA_BYTES,
    diskReserveBytes: options.limits?.diskReserveBytes ?? DISK_RESERVE_BYTES,
  }
  // Bytes a user may still upload, given their own quota and the free space
  // on the disk. `replacing` is an asset whose current blob is about to be
  // overwritten and therefore does not count as used.
  const uploadAllowance = (ownerId: string, replacing?: string): { bytes: number; reason: string } => {
    let used = 0
    for (const assetId of store.listAssetIdsForOwner(ownerId)) {
      if (assetId !== replacing) used += blobByteLength(assetId)
    }
    const quotaLeft = limits.userStorageQuotaBytes - used
    let diskLeft = Number.MAX_SAFE_INTEGER
    try {
      diskLeft = freeDiskBytes() - limits.diskReserveBytes
    } catch {
      // statfs unavailable: rely on the per-user quota alone.
    }
    return diskLeft < quotaLeft
      ? { bytes: Math.max(0, diskLeft), reason: "server storage is full" }
      : { bytes: Math.max(0, quotaLeft), reason: "storage quota exceeded" }
  }

  const requireAuth = (ctx: Ctx): string => {
    const userId = authmod.authenticate(store, ctx.req.headers.authorization)
    ctx.userId = userId
    return userId
  }
  const requireSession = (ctx: Ctx) => {
    const session = authmod.authenticateSession(store, ctx.req.headers.authorization)
    ctx.userId = session.userId
    return session
  }
  const deviceLabel = (ctx: Ctx): string => {
    const header = ctx.req.headers["user-agent"]
    const value = Array.isArray(header) ? header[0] : header
    return value ? value.replace(/\s+/g, " ").trim().slice(0, 120) : "Browser session"
  }
  // Privacy rule for "who may see me" and "who may call me": an explicit
  // exception wins, otherwise the policy decides, and a contact is someone the
  // owner shares a one-to-one chat with.
  const privacyAllows = (ownerId: string, viewerId: string, scope: PrivacyScope): boolean => {
    if (ownerId === viewerId) return true
    const exception = store.getPrivacyException(ownerId, viewerId, scope)
    if (exception === "allow") return true
    if (exception === "deny") return false
    const settings = store.getUserSettings(ownerId)
    const policy: PrivacyPolicy =
      scope === "calls" ? settings.callsPolicy : scope === "seenTime" ? settings.seenTimePolicy : settings.lastSeenPolicy
    if (policy === "nobody") return false
    if (policy === "contacts") return store.isDirectContact(ownerId, viewerId)
    return true
  }
  // Two separate questions: may the viewer see that the owner is online right
  // now, and may the viewer see when the owner was last online. Ghost mode
  // answers both with no.
  const canSeeOnline = (ownerId: string, viewerId: string): boolean => {
    if (store.isGhostMode(ownerId)) return false
    return privacyAllows(ownerId, viewerId, "lastSeen")
  }
  const canSeeSeenTime = (ownerId: string, viewerId: string): boolean => {
    if (store.isGhostMode(ownerId)) return false
    return privacyAllows(ownerId, viewerId, "seenTime")
  }
  // The stored time is the end of the last finished session; it does not move
  // while the owner is online, so someone who may see the time but not the
  // online status cannot tell that the owner is here right now.
  const lastSeenFor = (ownerId: string, viewerId: string): string | null =>
    canSeeSeenTime(ownerId, viewerId) ? store.getLastSeen(ownerId) : null

  // What one viewer may learn about one user's presence in one conversation.
  const presenceFor = (ownerId: string, viewerId: string, conversationId: string): WsEvent =>
    ({
      type: "presence.updated",
      conversationId,
      userId: ownerId,
      online: bus.isUserVisible(ownerId) && canSeeOnline(ownerId, viewerId),
      lastSeenAt: lastSeenFor(ownerId, viewerId),
    }) as WsEvent

  // Presence goes only to members of conversations the user already belongs
  // to, so there is no global online roster to discover people with. With
  // `viewers`, only those members are told (after an exception changed).
  const broadcastPresence = (ownerId: string, viewers?: Set<string>): void => {
    for (const conversationId of store.listConversationIdsForUser(ownerId)) {
      for (const member of store.listMembers(conversationId)) {
        if (member.userId === ownerId) continue
        if (viewers && !viewers.has(member.userId)) continue
        bus.publishToUsers([member.userId], presenceFor(ownerId, member.userId, conversationId))
      }
    }
  }

  // Heartbeat for everyone online and not hiding: keeps the stored time close
  // to reality even when the process stops before sockets can disconnect.
  const refreshLastSeen = (): void => {
    const ids = bus.visibleUserIds().filter((id) => !store.isGhostMode(id))
    store.touchActive(ids, new Date().toISOString())
  }

  startPresenceBroadcast()
  startCallCleanup()

  const requireMember = (conversationId: string, userId: string): MemberRow => {
    if (!store.getConversation(conversationId)) throw new HttpError(404, "conversation not found")
    const member = store.getMember(conversationId, userId)
    if (!member) throw new HttpError(403, "not a member of this conversation")
    return member
  }
  const requireModerator = (conversationId: string, userId: string): MemberRow => {
    const member = requireMember(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (conversation?.kind !== "direct" && member.role !== "owner" && member.role !== "admin") {
      throw new HttpError(403, "moderator permission is required")
    }
    return member
  }
  const requireCanSend = (conversationId: string, userId: string): MemberRow => {
    const member = requireMember(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (member.role === "restricted") throw new HttpError(403, "your role is read-only")
    if (conversation?.kind === "channel" && member.role !== "owner" && member.role !== "admin") {
      throw new HttpError(403, "only channel administrators can post")
    }
    return member
  }
  const requireCanReact = (conversationId: string, userId: string): MemberRow => {
    const member = requireMember(conversationId, userId)
    if (member.role === "restricted") throw new HttpError(403, "your role is read-only")
    return member
  }
  const requireOwnedFolder = (folderId: string, userId: string) => {
    const folder = store.getConversationFolder(folderId)
    if (!folder || folder.userId !== userId) throw new HttpError(404, "folder not found")
    return folder
  }
  const toEnvelope = (m: MessageRow): MessageEnvelope => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    ciphertext: m.ciphertext,
    createdAt: m.createdAt,
    replyTo: m.replyTo ?? undefined,
    editedAt: m.editedAt ?? undefined,
    deletedAt: m.deletedAt ?? undefined,
    ...(m.silent ? { silent: true } : {}),
  })
  const toPollSummary = (poll: PollSnapshot): PollSummary => ({
    messageId: poll.messageId,
    conversationId: poll.conversationId,
    creatorId: poll.creatorId,
    optionCount: poll.optionCount,
    multipleChoice: poll.multipleChoice,
    quiz: poll.quiz,
    closedAt: poll.closedAt,
    createdAt: poll.createdAt,
    optionCounts: poll.optionCounts,
    totalVoters: poll.totalVoters,
    myOptionIndexes: poll.myOptionIndexes,
  })
  const toPollUpdate = (poll: PollSnapshot): PollRealtimeUpdate => ({
    messageId: poll.messageId,
    optionCounts: poll.optionCounts,
    totalVoters: poll.totalVoters,
    closedAt: poll.closedAt,
  })
  const publishPollUpdate = (conversationId: string, poll: PollSnapshot): void => {
    const members = store.listMembers(conversationId).map((member) => member.userId)
    bus.publishToUsers(members, { type: "poll.updated", conversationId, update: toPollUpdate(poll) } as WsEvent)
  }
  const rowToRecord = (r: ReplicaRow): ReplicaRecord => ({
    id: r.id,
    fileAssetId: r.fileAssetId,
    state: r.state,
    tempExpiresAt: r.tempExpiresAt,
    updatedAt: r.updatedAt,
  })
  const recordToRow = (rec: ReplicaRecord): ReplicaRow => ({
    id: rec.id,
    fileAssetId: rec.fileAssetId,
    state: rec.state,
    tempExpiresAt: rec.tempExpiresAt,
    updatedAt: rec.updatedAt,
  })
  const publishReplica = (conversationId: string, fileAssetId: string, replica: ReplicaRow): void => {
    const members = store.listMembers(conversationId).map((m) => m.userId)
    const event = {
      type: "file.state_changed",
      fileAssetId,
      replicaId: replica.id,
      state: replica.state,
      tempExpiresAt: replica.tempExpiresAt != null ? new Date(replica.tempExpiresAt).toISOString() : null,
    } as unknown as WsEvent
    bus.publishToUsers(members, event)
  }

  const createDirectConversation = (a: string, b: string): ConversationRow => {
    const now = new Date().toISOString()
    const conversation = { id: newId("conv"), kind: "direct" as ConversationKind, title: null, createdBy: a, createdAt: now }
    store.createConversation(conversation)
    store.addMember({ conversationId: conversation.id, userId: a, role: "member", joinedAt: now })
    store.addMember({ conversationId: conversation.id, userId: b, role: "member", joinedAt: now })
    return store.getConversation(conversation.id) as ConversationRow
  }
  const ensureSelfConversation = (userId: string): ConversationRow => {
    const existing = store.findSelfConversation(userId)
    if (existing) return existing
    const now = new Date().toISOString()
    const conversation = { id: newId("conv"), kind: "direct" as ConversationKind, title: null, createdBy: userId, createdAt: now }
    store.createConversation(conversation)
    store.addMember({ conversationId: conversation.id, userId, role: "owner", joinedAt: now })
    store.setConversationSelf(conversation.id)
    return store.getConversation(conversation.id) as ConversationRow
  }
  const notifyFriendAccepted = (a: string, b: string, conversation: ConversationRow): void => {
    const ua = store.getUserById(a)
    const ub = store.getUserById(b)
    bus.publishToUsers([a], { type: "friend.accepted", conversation: { ...conversation, peer: ub ? authmod.publicUser(ub) : null } } as unknown as WsEvent)
    bus.publishToUsers([b], { type: "friend.accepted", conversation: { ...conversation, peer: ua ? authmod.publicUser(ua) : null } } as unknown as WsEvent)
  }

  // --- optional account email, recovery codes, push and updates ---
  // An account never requires an email address. When the user attaches one it is
  // confirmed with a short code, and from then on it can be used to reset a
  // forgotten password. Codes are stored hashed and consumed on first use.
  const mailer = createMailer()
  const webpush = new WebPushSender(store)
  const push = new PushSender(store, (id: string) => bus.isUserOnline(id), undefined, webpush, {
    accountName: (id: string) => store.getUserById(id)?.displayName ?? null,
  })
  const botHub = new BotHub(store)
  const notifyBots = (conversationId: string, update: Record<string, unknown>, exceptBotId?: string): void => {
    botHub.notifyConversation(conversationId, update, exceptBotId)
  }
  const senderView = (userId: string) => {
    const u = store.getUserById(userId)
    return { id: userId, username: u?.username ?? null, displayName: u?.displayName ?? null, isBot: Boolean(u?.isBot) }
  }
  // Every path that creates a message ends here: stored, fanned out to the
  // members' sockets, announced by push (unless sent silently) and queued for
  // the bots in the chat.
  const deliverMessage = (message: MessageRow): void => {
    store.createMessage(message)
    const members = store.listMembers(message.conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "message.created", message: toEnvelope(message) })
    if (!message.silent) notifyMessagePush(message.conversationId, message.senderId, members)
    const conversation = store.getConversation(message.conversationId)
    notifyBots(
      message.conversationId,
      { type: "message", conversationId: message.conversationId, conversation: conversation ? { id: conversation.id, kind: conversation.kind, title: conversation.title } : null, message: toEnvelope(message), sender: senderView(message.senderId) },
      message.senderId,
    )
  }
  const publishMessageUpdated = (message: MessageRow): void => {
    const members = store.listMembers(message.conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "message.updated", message: toEnvelope(message) })
    notifyBots(message.conversationId, { type: "message_edited", conversationId: message.conversationId, message: toEnvelope(message), sender: senderView(message.senderId) }, message.senderId)
  }
  const publishMessageDeleted = (conversationId: string, messageId: string): void => {
    const members = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "message.deleted", conversationId, messageId } as unknown as WsEvent)
    notifyBots(conversationId, { type: "message_deleted", conversationId, messageId })
  }
  const EMAIL_CODE_TTL_MINUTES = 15
  const EMAIL_CODE_MAX_ATTEMPTS = 5
  const PURPOSE_VERIFY = "verify"
  const PURPOSE_RESET = "reset"

  const hashEmailCode = (code: string): string => createHash("sha256").update(code).digest("hex")
  const newEmailCode = (): string => String(randomInt(0, 1000000)).padStart(6, "0")
  const hashesMatch = (a: string, b: string): boolean => {
    const left = Buffer.from(a, "utf8")
    const right = Buffer.from(b, "utf8")
    return left.length === right.length && timingSafeEqual(left, right)
  }
  const sixDigits = (value: unknown): string => {
    const code = String(value ?? "").trim()
    if (!/^[0-9]{6}$/.test(code)) throw new HttpError(400, "enter the six digit code from the email")
    return code
  }
  const cleanDeviceId = (value: unknown): string => String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)

  const issueEmailCode = async (userId: string, email: string, purpose: string): Promise<boolean> => {
    if (!mailer.enabled) throw new HttpError(503, "email delivery is not configured on this server")
    const code = newEmailCode()
    const now = new Date()
    store.createEmailCode({
      id: newId("ecode"),
      userId,
      email,
      purpose,
      codeHash: hashEmailCode(code),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MINUTES * 60000).toISOString(),
      attempts: 0,
    })
    const template =
      purpose === PURPOSE_RESET
        ? passwordResetEmail(code, EMAIL_CODE_TTL_MINUTES)
        : verificationEmail(code, EMAIL_CODE_TTL_MINUTES)
    try {
      await mailer.send({ to: email, subject: template.subject, text: template.text })
      return true
    } catch (err) {
      // A refused delivery keeps the code valid. The message often lands later
      // through the fallback route, so the screen keeps the input visible and
      // offers a resend instead of discarding the attempt.
      if (err instanceof MailerDisabledError) {
        store.deleteEmailCodes(userId, purpose)
        throw new HttpError(503, "email delivery is not configured on this server")
      }
      console.error("[api] email delivery failed", err)
      return false
    }
  }

  // A code dies on success and after a handful of wrong guesses, so six digits
  // cannot be brute forced.
  const consumeEmailCode = (userId: string, purpose: string, code: string): string => {
    const record = store.getEmailCode(userId, purpose)
    if (!record) throw new HttpError(400, "no code was requested, or it has already been used")
    if (Date.parse(record.expiresAt) <= Date.now()) {
      store.deleteEmailCodes(userId, purpose)
      throw new HttpError(400, "the code has expired, request a new one")
    }
    if (!hashesMatch(record.codeHash, hashEmailCode(code))) {
      const attempts = store.bumpEmailCodeAttempts(record.id)
      if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) store.deleteEmailCodes(userId, purpose)
      throw new HttpError(400, "invalid code")
    }
    store.deleteEmailCodes(userId, purpose)
    return record.email
  }

  const pushTitle = (conversationId: string, senderId: string): string => {
    const conversation = store.getConversation(conversationId)
    if (conversation && conversation.kind !== "direct" && conversation.title) return conversation.title
    const sender = store.getUserById(senderId)
    return sender ? sender.displayName : "FrontierX"
  }

  // Message bodies are end-to-end encrypted, so a push can only announce that
  // something arrived; the client shows the text once it decrypts locally.
  const notifyMessagePush = (conversationId: string, senderId: string, members: string[]): void => {
    push.notifyUsers(
      members,
      { type: "message", title: pushTitle(conversationId, senderId), body: "Новое сообщение", conversationId },
      { exclude: [senderId] },
    )
  }

  // A ringing call is worth waking the device for even when a socket is open,
  // because the other clients may be in the background.
  const notifyCallPush = (conversationId: string, callerId: string, targets: string[]): void => {
    push.notifyUsers(
      targets,
      { type: "call", title: pushTitle(conversationId, callerId), body: "Входящий звонок", conversationId },
      { exclude: [callerId], force: true },
    )
  }

  router.get("/api/me/email", (ctx) => {
    const userId = requireAuth(ctx)
    const current = store.getUserEmail(userId)
    const pending = store.getEmailCode(userId, PURPOSE_VERIFY)
    const pendingLive = pending && Date.parse(pending.expiresAt) > Date.now() ? pending : null
    sendJson(ctx.res, 200, {
      email: current.verifiedAt ? current.email : null,
      verifiedAt: current.verifiedAt,
      pending: pendingLive ? { email: pendingLive.email, expiresAt: pendingLive.expiresAt } : null,
      mailerEnabled: mailer.enabled,
    })
  })

  router.post("/api/me/email/start", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("email-start:" + userId, 5, 3600000)
    const b = await readJson(ctx.req)
    const email = normalizeEmail(b.email)
    if (!isValidEmail(email)) throw new HttpError(400, "enter a valid email address")
    if (store.isEmailTaken(email, userId)) throw new HttpError(409, "this address is already attached to another account")
    const sent = await issueEmailCode(userId, email, PURPOSE_VERIFY)
    sendJson(ctx.res, 200, { ok: true, email, sent, ttlMinutes: EMAIL_CODE_TTL_MINUTES })
  })

  router.post("/api/me/email/verify", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("email-verify:" + userId, 20, 3600000)
    const b = await readJson(ctx.req)
    const code = sixDigits(b.code)
    const email = consumeEmailCode(userId, PURPOSE_VERIFY, code)
    if (store.isEmailTaken(email, userId)) throw new HttpError(409, "this address is already attached to another account")
    const verifiedAt = new Date().toISOString()
    store.setUserEmail(userId, email, verifiedAt)
    sendJson(ctx.res, 200, { email, verifiedAt })
  })

  router.post("/api/me/email/remove", (ctx) => {
    const userId = requireAuth(ctx)
    store.setUserEmail(userId, null, null)
    store.deleteEmailCodes(userId, PURPOSE_VERIFY)
    store.deleteEmailCodes(userId, PURPOSE_RESET)
    sendJson(ctx.res, 200, { email: null, verifiedAt: null })
  })

  // Recovery answers identically whatever happens, so the endpoint cannot be
  // used to discover which addresses have accounts.
  router.post("/api/auth/password/forgot", async (ctx) => {
    rateLimit("forgot:" + clientIp(ctx), 10, 3600000)
    const b = await readJson(ctx.req)
    const email = normalizeEmail(b.email)
    const accepted = { ok: true, ttlMinutes: EMAIL_CODE_TTL_MINUTES }
    if (!isValidEmail(email) || !mailer.enabled) {
      sendJson(ctx.res, 200, accepted)
      return
    }
    const userId = store.findUserIdByEmail(email)
    if (userId) {
      try {
        await issueEmailCode(userId, email, PURPOSE_RESET)
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
      }
    }
    sendJson(ctx.res, 200, accepted)
  })

  router.post("/api/auth/password/reset", async (ctx) => {
    rateLimit("reset:" + clientIp(ctx), 20, 3600000)
    const b = await readJson(ctx.req)
    const email = normalizeEmail(b.email)
    const code = sixDigits(b.code)
    const password = String(b.password ?? "")
    if (password.length < 8) throw new HttpError(400, "password must be at least 8 characters")
    const userId = store.findUserIdByEmail(email)
    if (!userId) throw new HttpError(400, "invalid code")
    consumeEmailCode(userId, PURPOSE_RESET, code)
    store.updateUserPassword(userId, hashPassword(password))
    // The key slot sealed with the old password stays, marked stale: the old
    // password (or any device that still holds the keys) can unlock the chats
    // once more, and that device then seals the keys with the new password.
    const changedAt = new Date().toISOString()
    store.markPasswordSlotsStale(userId, changedAt)
    store.setPasswordChangedAt(userId, changedAt)
    // Recovery has to lock out whoever knew the old password.
    store.deleteAllSessionsForUser(userId)
    sendJson(ctx.res, 200, { ok: true })
  })

  // Changing the password while signed in: the client re-seals the account key
  // with the new password in the same request, so the two never disagree.
  router.post("/api/me/password", async (ctx) => {
    const session = requireSession(ctx)
    const userId = session.userId
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    const nameKey = "login-name:" + user.username.toLowerCase()
    rateGuard(nameKey, 8, 900000)
    const b = await readJson(ctx.req)
    if (!verifyPassword(String(b.currentPassword ?? ""), user.passwordHash)) {
      rateHit(nameKey, 900000)
      throw new HttpError(401, "invalid credentials")
    }
    rateClear(nameKey)
    const next = String(b.newPassword ?? "")
    if (next.length < 8) throw new HttpError(400, "password must be at least 8 characters")
    if (next.length > 1024) throw new HttpError(400, "password is too long")
    const now = new Date().toISOString()
    let slot: KeySlotRow | null = null
    if (b.passwordSlot !== undefined && b.passwordSlot !== null) {
      if (!store.getAccountKey(userId)) throw new HttpError(409, "create the account key first")
      if (typeof b.passwordSlot !== "object") throw new HttpError(400, "slot is invalid")
      slot = slotFromBody(userId, { ...(b.passwordSlot as Record<string, unknown>), kind: "password" }, now)
    } else if (store.getAccountKey(userId)) {
      throw new HttpError(400, "the account key must be sealed with the new password")
    }
    store.updateUserPassword(userId, hashPassword(next))
    store.setPasswordChangedAt(userId, now)
    if (slot) store.putKeySlot(slot)
    if (b.legacyBackup && typeof b.legacyBackup === "object") {
      const lb = b.legacyBackup as Record<string, unknown>
      const iterations = Math.floor(Number(lb.iterations ?? 0))
      if (iterations >= 50000 && iterations <= 2000000) {
        store.putKeyBackup({
          userId,
          salt: b64Field(lb.salt, "salt", 256),
          iv: b64Field(lb.iv, "iv", 256),
          ciphertext: b64Field(lb.ciphertext, "ciphertext", 4096),
          iterations,
          publicKey: b64Field(lb.publicKey, "publicKey", 2000),
          updatedAt: now,
        })
      }
    }
    const revoked = b.signOutOthers === true ? store.deleteOtherSessions(userId, session.id) : 0
    sendJson(ctx.res, 200, { ok: true, revoked })
  })

  router.post("/api/me/push/register", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const endpoint = String(b.endpoint ?? "").trim()
    if (!isAcceptableEndpoint(endpoint)) throw new HttpError(400, "invalid push endpoint")
    const deviceId = cleanDeviceId(b.deviceId)
    const now = new Date().toISOString()
    if (deviceId) store.deletePushEndpointsForDevice(userId, deviceId)
    store.savePushEndpoint({ id: newId("push"), userId, endpoint, deviceId: deviceId || null, createdAt: now, lastSeenAt: now })
    sendJson(ctx.res, 200, { ok: true })
  })

  // Tells the Android app whether it can rely on FCM and drop its own
  // background connection (and with it the ongoing notification).
  router.get("/api/push/config", (ctx) => {
    sendJson(ctx.res, 200, { fcm: push.fcm.enabled })
  })

  router.post("/api/me/push/fcm", async (ctx) => {
    const userId = requireAuth(ctx)
    if (!push.fcm.enabled) throw new HttpError(503, "fcm is not configured on this server")
    rateLimit("push-fcm:" + userId, 30, 3600000)
    const b = await readJson(ctx.req)
    const token = String(b.token ?? "").trim()
    if (!/^[A-Za-z0-9_:\-]{20,4096}$/.test(token)) throw new HttpError(400, "invalid fcm token")
    const deviceId = cleanDeviceId(b.deviceId)
    const endpoint = FCM_PREFIX + token
    // One row per device, and a token belongs to one account at a time: a phone
    // that switches accounts must not keep notifying the previous one.
    store.deletePushEndpointByUrl(endpoint)
    if (deviceId) store.deletePushEndpointsForDevice(userId, deviceId)
    const now = new Date().toISOString()
    store.savePushEndpoint({ id: newId("push"), userId, endpoint, deviceId: deviceId || null, createdAt: now, lastSeenAt: now })
    sendJson(ctx.res, 200, { ok: true })
  })

  router.post("/api/me/push/unregister", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const endpoint = String(b.endpoint ?? "").trim()
    if (endpoint && store.listPushEndpoints(userId).some((row) => row.endpoint === endpoint)) {
      store.deletePushEndpointByUrl(endpoint)
    }
    const deviceId = cleanDeviceId(b.deviceId)
    if (deviceId) store.deletePushEndpointsForDevice(userId, deviceId)
    sendJson(ctx.res, 200, { ok: true })
  })

  router.post("/api/me/push/test", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("push-test:" + userId, 10, 600000)
    const delivered = await push.deliverToUser(userId, {
      type: "test",
      title: "FrontierX",
      body: "Уведомления работают",
    })
    // The socket channel inside the app shows the same test notification, so a
    // phone without any push distributor can still verify the setup.
    bus.publishToUsers([userId], { type: "push.test", title: "FrontierX", body: "Уведомления работают" } as unknown as WsEvent)
    sendJson(ctx.res, 200, { delivered, endpoints: store.listPushEndpoints(userId).length })
  })

  // Clients ask what the newest build is and compare it with their own version.
  // Files themselves are static downloads served next to the web app.
  router.get("/api/updates/latest", (ctx) => {
    const platform = String(ctx.query.get("platform") ?? "")
    if (!isPlatform(platform)) throw new HttpError(400, "unknown platform")
    const latest = latestRelease(platform)
    if (!latest) {
      sendJson(ctx.res, 200, { latest: null, updateAvailable: false })
      return
    }
    const version = String(ctx.query.get("version") ?? "")
    const rawCode = Number(ctx.query.get("versionCode") ?? 0)
    const versionCode = Number.isFinite(rawCode) ? Math.floor(rawCode) : 0
    sendJson(ctx.res, 200, { latest, updateAvailable: isNewerThan(latest, { version, versionCode }) })
  })

  // --- health ---
  router.get("/api/health", (ctx) => sendJson(ctx.res, 200, { ok: true, service: "frontierx-api", protocol: 1 }))
// friends, user search, membership, invites (added routes)
  router.get("/api/friends", (ctx) => {
    const userId = requireAuth(ctx)
    const friends = store.listDirectPeers(userId).map((row) => ({
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      avatar: row.user.avatar ?? null,
      conversationId: row.conversationId,
    }))
    sendJson(ctx.res, 200, { friends })
  })
  router.post("/api/friends/:userId/remove", (ctx) => {
    const userId = requireAuth(ctx)
    const otherId = ctx.params.userId
    const conversation = store.findDirectConversationBetween(userId, otherId)
    if (!conversation) throw new HttpError(404, "friend not found")
    store.deleteConversation(conversation.id)
    bus.publishToUsers([otherId], { type: "friend.removed", conversationId: conversation.id, by: userId } as unknown as WsEvent)
    bus.publishToUsers([userId], { type: "friend.removed", conversationId: conversation.id, by: userId } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true, conversationId: conversation.id })
  })
  router.get("/api/users/search", (ctx) => {
    const userId = requireAuth(ctx)
    const q = (ctx.query.get("q") ?? "").trim()
    rateLimit("user-search:" + userId, 120, 60000)
    if (!q) { sendJson(ctx.res, 200, { users: [] }); return }
    if (q.length === 1) { sendJson(ctx.res, 200, { users: [] }); return }
    const users = store.searchUsers(q, userId, 10).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar ?? null, isBot: Boolean(u.isBot) }))
    sendJson(ctx.res, 200, { users })
  })
  router.post("/api/conversations/:id/members/add", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireModerator(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation || conversation.kind === "direct") throw new HttpError(409, "members are managed only in groups and channels")
    const b = await readJson(ctx.req)
    const usernames = Array.isArray(b.usernames) ? b.usernames.map((u: unknown) => String(u)) : []
    const now = new Date().toISOString()
    const friendIds = new Set(store.listDirectPeers(userId).map((peer) => peer.user.id))
    const addedIds: string[] = []
    for (const username of usernames) {
      const other = store.getUserByUsername(username)
      if (other && !store.getMember(conversationId, other.id) && friendIds.has(other.id)) {
        if (other.isBot && !store.getBot(other.id)?.allowGroups) continue
        if (!other.isBot && store.getUserSettings(other.id).requireInvite) {
          const inviteId = store.getGroupInvitePair(conversationId, other.id)?.id ?? newId("ginv")
          store.createGroupInvite({ id: inviteId, conversationId, fromUser: userId, toUser: other.id, createdAt: now })
          const inviter = store.getUserById(userId)
          bus.publishToUsers([other.id], { type: "group.invite", invite: { id: inviteId, conversationId, conversationTitle: conversation.title ?? null, conversationKind: conversation.kind, fromUser: userId, fromName: inviter ? inviter.displayName : null, createdAt: now } } as unknown as WsEvent)
        } else {
          store.addMember({ conversationId, userId: other.id, role: "member", joinedAt: now })
          addedIds.push(other.id)
        }
      }
    }
    const members = store.listMembers(conversationId).map((m) => {
      const u = store.getUserById(m.userId)
      return { userId: m.userId, role: m.role, username: u ? u.username : null, displayName: u ? u.displayName : null, publicKey: u ? u.publicKey : null, avatar: u ? u.avatar : null, isBot: Boolean(u?.isBot) }
    })
    const existingIds = store.listMembers(conversationId).map((m) => m.userId)
    for (const id of addedIds) {
      bus.publishToUsers([id], { type: "conversation.added", conversation } as unknown as WsEvent)
      bus.publishToUsers(existingIds, { type: "member.added", conversationId, userId: id } as unknown as WsEvent)
      if (store.isBot(id)) botHub.notifyBot(id, { type: "conversation_added", conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title }, addedBy: senderView(userId) })
    }
    if (addedIds.length > 0) {
      bus.publishToUsers(existingIds.filter((id) => !addedIds.includes(id)), { type: "keys.shares_needed", conversationId } as unknown as WsEvent)
      notifyBots(conversationId, { type: "keys_updated", conversationId })
    }
    sendJson(ctx.res, 200, { members })
  })
  router.post("/api/conversations/:id/leave", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation || conversation.kind === "direct") throw new HttpError(409, "you can only leave groups and channels")
    store.removeMember(conversationId, userId)
    // New messages get a key the person who left never had.
    store.markRekeyNeeded(conversationId)
    bus.publishToUsers([userId], { type: "conversation.deleted", conversationId } as unknown as WsEvent)
    const remaining = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(remaining, { type: "member.removed", conversationId, userId } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/conversations/:id/delete", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation) throw new HttpError(404, "conversation not found")
    if (conversation.kind === "direct") throw new HttpError(409, "direct chats cannot be deleted")
    if (conversation.createdBy !== userId) throw new HttpError(403, "only the creator can delete this conversation")
    const memberIds = store.listMembers(conversationId).map((m) => m.userId)
    store.deleteConversation(conversationId)
    bus.publishToUsers(memberIds, { type: "conversation.deleted", conversationId } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/conversations/:id/invite", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireModerator(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation || conversation.kind === "direct") throw new HttpError(409, "invites are available only for groups and channels")
    // The creator picks how long the link works; null or 0 means until the
    // chat is deleted.
    const b = await readJson(ctx.req)
    const rawTtl = b.expiresInSeconds
    let expiresAt: string | null = null
    if (rawTtl !== undefined && rawTtl !== null && rawTtl !== 0) {
      const seconds = Number(rawTtl)
      if (!Number.isFinite(seconds) || seconds < 60 || seconds > 31536000) throw new HttpError(400, "expiresInSeconds must be between 60 and 31536000, or null")
      expiresAt = new Date(Date.now() + Math.floor(seconds) * 1000).toISOString()
    }
    const code = newId("inv")
    store.createInvite({ code, conversationId, createdBy: userId, createdAt: new Date().toISOString(), expiresAt })
    sendJson(ctx.res, 200, { code, expiresAt })
  })
  // An expired link is removed on first use and answers like a missing one,
  // with its own message so the page can say why.
  const requireLiveInvite = (code: string) => {
    const invite = store.getInvite(code)
    if (!invite) throw new HttpError(404, "invite not found")
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
      store.deleteInvite(code)
      throw new HttpError(410, "invite has expired")
    }
    return invite
  }
  router.get("/api/invites/:code", (ctx) => {
    rateLimit("invite:" + clientIp(ctx), 30, 60000)
    const invite = requireLiveInvite(ctx.params.code)
    const conversation = store.getConversation(invite.conversationId)
    if (!conversation) throw new HttpError(404, "conversation not found")
    sendJson(ctx.res, 200, { code: invite.code, kind: conversation.kind, title: conversation.title, avatar: conversation.avatar ?? null, expiresAt: invite.expiresAt ?? null })
  })
  router.post("/api/invites/:code/join", (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("invite-join:" + userId, 30, 60000)
    const invite = requireLiveInvite(ctx.params.code)
    const conversation = store.getConversation(invite.conversationId)
    if (!conversation) throw new HttpError(404, "conversation not found")
    if (!store.getMember(conversation.id, userId)) {
      store.addMember({ conversationId: conversation.id, userId, role: "member", joinedAt: new Date().toISOString() })
      const existingIds = store.listMembers(conversation.id).map((m) => m.userId).filter((id) => id !== userId)
      bus.publishToUsers(existingIds, { type: "member.added", conversationId: conversation.id, userId } as unknown as WsEvent)
    }
    sendJson(ctx.res, 200, { conversation })
  })

  // --- auth ---
  const purgeAccount = (userId: string): number => {
    // Bots belong to their owner and go with the account, chats with them too.
    for (const bot of store.listBotsForOwner(userId)) {
      const groups = dropBotDirectChats(store, bus, bot.id)
      const botResult = store.deleteUserAccount(bot.id)
      for (const assetId of botResult.assetIds) {
        try {
          deleteBlob(assetId)
        } catch {}
      }
      announceBotRemoved(store, bus, bot.id, groups)
    }
    const result = store.deleteUserAccount(userId)
    for (const assetId of result.assetIds) {
      try {
        deleteBlob(assetId)
      } catch {}
    }
    return result.conversationsDeleted
  }
  router.post("/api/me/delete", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("account-delete:" + userId, 5, 3600000)
    const b = await readJson(ctx.req)
    const user = store.getUserById(userId)
    if (!user || !verifyPassword(String(b.password ?? ""), user.passwordHash)) {
      throw new HttpError(401, "invalid credentials")
    }
    const conversationsDeleted = purgeAccount(userId)
    sendJson(ctx.res, 200, { deleted: true, conversationsDeleted })
  })
  router.post("/api/account/delete", async (ctx) => {
    rateLimit("account-delete-ip:" + clientIp(ctx), 10, 3600000)
    const b = await readJson(ctx.req)
    const username = String(b.username ?? "").trim()
    const password = String(b.password ?? "")
    if (!username || !password) throw new HttpError(400, "username and password are required")
    // This endpoint checks a password just like login does, so it shares the
    // per-account lockout; otherwise it would be a way around it.
    const nameKey = "login-name:" + username.toLowerCase()
    rateGuard(nameKey, 8, 900000)
    rateHit(nameKey, 900000)
    const user = store.getUserByUsername(username)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, "invalid credentials")
    }
    rateClear(nameKey)
    const conversationsDeleted = purgeAccount(user.id)
    sendJson(ctx.res, 200, { deleted: true, conversationsDeleted })
  })
  router.post("/api/auth/register", async (ctx) => {
    const b = await readJson(ctx.req)
    rateLimit("register:" + clientIp(ctx), 10, 3600000)
    // The client creates the account key before the account exists, so both
    // land together and no other device can ever create a competing one.
    const registeredAt = new Date().toISOString()
    const keyBundle = b.keys !== undefined && b.keys !== null ? parseAccountBundle(store, "pending", b.keys, registeredAt) : null
    const result = authmod.register(
      store,
      String(b.username ?? ""),
      String(b.password ?? ""),
      b.displayName != null ? String(b.displayName) : undefined,
      b.publicKey != null ? String(b.publicKey) : undefined,
      deviceLabel(ctx),
      b.deviceId != null ? String(b.deviceId) : undefined,
    )
    // An address can be attached right at sign-up. It stays optional: nothing
    // here can block account creation, and the address is only stored once the
    // user confirms the code, either on this screen or later in settings.
    const rawEmail = b.email != null ? normalizeEmail(b.email) : ""
    const newUserId = String((result.user as { id?: string }).id ?? "")
    if (keyBundle && newUserId) {
      store.createAccountKey({
        userId: newUserId,
        checkIv: keyBundle.check.iv,
        checkCiphertext: keyBundle.check.ciphertext,
        slots: keyBundle.slots.map((slot) => ({ ...slot, userId: newUserId })),
        vault: keyBundle.vault.map((item) => ({ ...item, userId: newUserId })),
        now: registeredAt,
      })
    }
    let email: { pending: string | null; sent: boolean; error: string | null } = { pending: null, sent: false, error: null }
    if (rawEmail && newUserId) {
      if (!isValidEmail(rawEmail)) email = { pending: null, sent: false, error: "invalid" }
      else if (store.isEmailTaken(rawEmail, newUserId)) email = { pending: null, sent: false, error: "taken" }
      else if (!mailer.enabled) email = { pending: rawEmail, sent: false, error: "unavailable" }
      else {
        try {
          const sent = await issueEmailCode(newUserId, rawEmail, PURPOSE_VERIFY)
          email = { pending: rawEmail, sent, error: sent ? null : "send-failed" }
        } catch {
          email = { pending: rawEmail, sent: false, error: "send-failed" }
        }
      }
    }
    sendJson(ctx.res, 201, { ...result, email, emailTtlMinutes: EMAIL_CODE_TTL_MINUTES })
  })
  router.post("/api/auth/login", async (ctx) => {
    const b = await readJson(ctx.req)
    const loginIpKey = "login:" + clientIp(ctx)
    const loginNameKey = "login-name:" + String(b.username ?? "").toLowerCase()
    rateGuard(loginIpKey, 20, 600000)
    rateGuard(loginNameKey, 8, 900000)
    rateHit(loginIpKey, 600000)
    rateHit(loginNameKey, 900000)
    const loginUser = store.getUserByUsername(String(b.username ?? ""))
    if (loginUser && loginUser.isBot) throw new HttpError(401, "invalid credentials")
    const result = authmod.login(store, String(b.username ?? ""), String(b.password ?? ""), deviceLabel(ctx), b.deviceId != null ? String(b.deviceId) : undefined)
    rateClear(loginIpKey)
    rateClear(loginNameKey)
    sendJson(ctx.res, 200, result)
  })
  router.get("/api/me", (ctx) => {
    const userId = requireAuth(ctx)
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    sendJson(ctx.res, 200, { user: authmod.publicUser(user) })
  })
  const readPolicy = (value: unknown, fallback: PrivacyPolicy): PrivacyPolicy => {
    if (value === undefined || value === null) return fallback
    if (value !== "everyone" && value !== "contacts" && value !== "nobody") throw new HttpError(400, "policy must be everyone, contacts or nobody")
    return value
  }
  const settingsPayload = (userId: string) => ({
    ...store.getUserSettings(userId),
    exceptions: store.listPrivacyExceptions(userId),
  })
  router.get("/api/me/settings", (ctx) => {
    const userId = requireAuth(ctx)
    sendJson(ctx.res, 200, settingsPayload(userId))
  })
  router.post("/api/me/privacy/exceptions", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const targetId = String(b.targetId ?? "")
    if (!targetId || targetId === userId) throw new HttpError(400, "targetId is required")
    const scope: PrivacyScope | null = b.scope === "calls" || b.scope === "lastSeen" || b.scope === "seenTime" ? b.scope : null
    if (!scope) throw new HttpError(400, "scope must be lastSeen, seenTime or calls")
    const rawMode = b.mode ?? null
    if (rawMode !== null && rawMode !== "allow" && rawMode !== "deny") throw new HttpError(400, "mode must be allow, deny or null")
    // Only people you already have a one-to-one chat with can be listed.
    if (rawMode !== null && !store.isDirectContact(userId, targetId)) throw new HttpError(409, "only contacts can be added to the exceptions")
    store.setPrivacyException(userId, targetId, scope, rawMode)
    // Only that one person's view changes; tell them right away.
    if (scope !== "calls") broadcastPresence(userId, new Set([targetId]))
    sendJson(ctx.res, 200, settingsPayload(userId))
  })
  router.post("/api/me/settings", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const prev = store.getUserSettings(userId)
    const nextInvite = b.requireInvite === undefined ? prev.requireInvite : Boolean(b.requireInvite)
    const nextGhost = b.ghostMode === undefined ? prev.ghostMode : Boolean(b.ghostMode)
    const nextLastSeen = readPolicy(b.lastSeenPolicy, prev.lastSeenPolicy)
    const nextSeenTime = readPolicy(b.seenTimePolicy, prev.seenTimePolicy)
    const nextCalls = readPolicy(b.callsPolicy, prev.callsPolicy)
    store.setUserSettings(userId, { requireInvite: nextInvite, ghostMode: nextGhost, lastSeenPolicy: nextLastSeen, seenTimePolicy: nextSeenTime, callsPolicy: nextCalls })
    // Leaving ghost mode while online starts the heartbeat from now on.
    if (prev.ghostMode && !nextGhost && bus.isUserVisible(userId)) store.touchActive([userId], new Date().toISOString())
    if (nextGhost !== prev.ghostMode || nextLastSeen !== prev.lastSeenPolicy || nextSeenTime !== prev.seenTimePolicy) {
      broadcastPresence(userId)
    }
    sendJson(ctx.res, 200, settingsPayload(userId))
  })
  router.get("/api/group-invites", (ctx) => {
    const userId = requireAuth(ctx)
    const invites = store.listGroupInvitesForUser(userId).map((inv) => {
      const conv = store.getConversation(inv.conversationId)
      const inviter = store.getUserById(inv.fromUser)
      return { id: inv.id, conversationId: inv.conversationId, conversationTitle: conv ? conv.title : null, conversationKind: conv ? conv.kind : "group", fromUser: inv.fromUser, fromName: inviter ? inviter.displayName : null, createdAt: inv.createdAt }
    })
    sendJson(ctx.res, 200, { invites })
  })
  router.post("/api/group-invites/:id/accept", (ctx) => {
    const userId = requireAuth(ctx)
    const invite = store.getGroupInviteById(ctx.params.id)
    if (!invite || invite.toUser !== userId) throw new HttpError(404, "invite not found")
    const conversation = store.getConversation(invite.conversationId)
    if (!conversation) { store.deleteGroupInvite(invite.id); throw new HttpError(404, "conversation not found") }
    if (!store.getMember(invite.conversationId, userId)) {
      store.addMember({ conversationId: invite.conversationId, userId, role: "member", joinedAt: new Date().toISOString() })
    }
    store.deleteGroupInvite(invite.id)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/group-invites/:id/decline", (ctx) => {
    const userId = requireAuth(ctx)
    const invite = store.getGroupInviteById(ctx.params.id)
    if (!invite || invite.toUser !== userId) throw new HttpError(404, "invite not found")
    store.deleteGroupInvite(invite.id)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/me/profile", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const displayName = String(b.displayName ?? "").trim()
    if (!displayName || displayName.length > 64) {
      throw new HttpError(400, "displayName must contain 1-64 characters")
    }
    store.updateUserDisplayName(userId, displayName)
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    sendJson(ctx.res, 200, { user: authmod.publicUser(user) })
  })
  router.post("/api/me/avatar", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const avatar = b.avatar === null || b.avatar === undefined || b.avatar === "" ? null : String(b.avatar)
    if (avatar && avatar.length > 700000) throw new HttpError(413, "avatar image is too large")
    if (avatar && !isImageDataUrl(avatar)) throw new HttpError(400, "avatar must be an image data url")
    store.setUserAvatar(userId, avatar)
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    for (const conversationId of store.listConversationIdsForUser(userId)) {
      const memberIds = store.listMembers(conversationId).map((m) => m.userId)
      bus.publishToUsers(memberIds, { type: "user.profile_updated", userId, displayName: user.displayName, avatar: user.avatar } as unknown as WsEvent)
    }
    sendJson(ctx.res, 200, { user: authmod.publicUser(user) })
  })
  router.get("/api/me/stickers", (ctx) => {
    const userId = requireAuth(ctx)
    sendJson(ctx.res, 200, { stickers: store.listStickers(userId) })
  })
  router.post("/api/me/stickers", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const data = String(b.data ?? "")
    if (!data) throw new HttpError(400, "sticker image is required")
    if (data.length > 2000000) throw new HttpError(413, "sticker image is too large")
    if (!isImageDataUrl(data)) throw new HttpError(400, "sticker must be an image data url")
    if (store.stickerBytesForUser(userId) + data.length > STICKER_GIF_QUOTA_BYTES) throw new HttpError(413, "sticker storage quota exceeded")
    const sticker = { id: newId("stk"), ownerId: userId, data, createdAt: new Date().toISOString() }
    store.createSticker(sticker)
    sendJson(ctx.res, 201, { sticker })
  })
  router.post("/api/me/stickers/:id/delete", (ctx) => {
    const userId = requireAuth(ctx)
    const sticker = store.getSticker(ctx.params.id)
    if (!sticker || sticker.ownerId !== userId) throw new HttpError(404, "sticker not found")
    store.deleteSticker(sticker.id)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.get("/api/me/sessions", (ctx) => {
    const current = requireSession(ctx)
    const sessions = store.listSessionsForUser(current.userId).map((session) => ({
      id: session.id,
      label: session.label,
      createdAt: session.createdAt,
      lastSeenAt: session.id === current.id ? current.lastSeenAt : session.lastSeenAt,
      expiresAt: session.expiresAt,
      current: session.id === current.id,
    }))
    sendJson(ctx.res, 200, { sessions, currentSessionId: current.id })
  })
  router.post("/api/me/sessions/revoke-others", (ctx) => {
    const current = requireSession(ctx)
    const revoked = store.deleteOtherSessions(current.userId, current.id)
    sendJson(ctx.res, 200, { revoked })
  })
  router.post("/api/me/sessions/:sessionId/revoke", (ctx) => {
    const current = requireSession(ctx)
    const sessionId = ctx.params.sessionId
    const revoked = store.deleteSessionForUser(current.userId, sessionId)
    if (!revoked) throw new HttpError(404, "session not found")
    sendJson(ctx.res, 200, { revoked: true, currentSessionRevoked: sessionId === current.id })
  })

  // --- personal organization ---
  router.get("/api/me/saved-messages", (ctx) => {
    const userId=requireAuth(ctx)
    sendJson(ctx.res,200,{saved:store.listSavedMessagesForUser(userId).map((v)=>({message:toEnvelope(v.message),savedAt:v.savedAt}))})
  })
  router.get("/api/me/folders", (ctx) => { const userId=requireAuth(ctx); sendJson(ctx.res,200,{folders:store.listConversationFolders(userId)}) })
  router.post("/api/me/folders", async (ctx) => {
    const userId=requireAuth(ctx); const body=await readJson(ctx.req); const name=String(body.name??"").trim()
    if (!name || name.length>48) throw new HttpError(400,"folder name must contain 1-48 characters")
    const folder={id:newId("folder"),userId,name,createdAt:new Date().toISOString(),conversationIds:[] as string[]}
    store.createConversationFolder(folder); bus.publishToUsers([userId],{type:"folder.updated",userId,folderId:folder.id,action:"created"} as WsEvent); sendJson(ctx.res,201,{folder})
  })
  router.post("/api/me/folders/:folderId/delete", (ctx) => { const userId=requireAuth(ctx); const folder=requireOwnedFolder(ctx.params.folderId,userId); store.deleteConversationFolder(folder.id); bus.publishToUsers([userId],{type:"folder.updated",userId,folderId:folder.id,action:"deleted"} as WsEvent); sendJson(ctx.res,200,{ok:true}) })
  router.post("/api/me/folders/:folderId/conversations", async (ctx) => { const userId=requireAuth(ctx); const folder=requireOwnedFolder(ctx.params.folderId,userId); const body=await readJson(ctx.req); const conversationId=String(body.conversationId??""); if(!conversationId) throw new HttpError(400,"conversationId is required"); requireMember(conversationId,userId); const active=body.active===undefined?true:Boolean(body.active); store.setFolderConversationMembership(folder.id,conversationId,active); bus.publishToUsers([userId],{type:"folder.updated",userId,folderId:folder.id,action:"updated"} as WsEvent); sendJson(ctx.res,200,{ok:true,active}) })

  // --- conversations ---
  router.post("/api/conversations", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const kindInput = String(b.kind ?? "")
    if (kindInput !== "group" && kindInput !== "channel") throw new HttpError(400, "only groups and channels can be created directly; direct messages start from a friend request")
    const kind: ConversationKind = kindInput
    const title = b.title != null ? String(b.title).trim() : ""
    if (title.length > 80) throw new HttpError(400, "title must contain 1-80 characters")
    const now = new Date().toISOString()
    const conversation = {
      id: newId("conv"),
      kind,
      title: title || null,
      createdBy: userId,
      createdAt: now,
    }
    store.createConversation(conversation)
    store.addMember({ conversationId: conversation.id, userId, role: "owner", joinedAt: now })
    const usernames = Array.isArray(b.memberUsernames) ? b.memberUsernames.map((u: unknown) => String(u)) : []
    const friendIds = new Set(store.listDirectPeers(userId).map((peer) => peer.user.id))
    const addedIds: string[] = []
    for (const username of usernames) {
      const other = store.getUserByUsername(username)
      if (other && other.id !== userId && friendIds.has(other.id)) {
        if (other.isBot && !store.getBot(other.id)?.allowGroups) continue
        if (!other.isBot && store.getUserSettings(other.id).requireInvite) {
          const inviteId = store.getGroupInvitePair(conversation.id, other.id)?.id ?? newId("ginv")
          store.createGroupInvite({ id: inviteId, conversationId: conversation.id, fromUser: userId, toUser: other.id, createdAt: now })
          const inviter = store.getUserById(userId)
          bus.publishToUsers([other.id], { type: "group.invite", invite: { id: inviteId, conversationId: conversation.id, conversationTitle: conversation.title ?? null, conversationKind: conversation.kind, fromUser: userId, fromName: inviter ? inviter.displayName : null, createdAt: now } } as unknown as WsEvent)
        } else {
          store.addMember({ conversationId: conversation.id, userId: other.id, role: "member", joinedAt: now })
          addedIds.push(other.id)
        }
      }
    }
    for (const addedId of addedIds) {
      bus.publishToUsers([addedId], { type: "conversation.added", conversation } as unknown as WsEvent)
      if (store.isBot(addedId)) botHub.notifyBot(addedId, { type: "conversation_added", conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title }, addedBy: senderView(userId) })
    }
    sendJson(ctx.res, 201, { conversation, members: store.listMembers(conversation.id) })
  })
  router.get("/api/conversations", (ctx) => {
    const userId = requireAuth(ctx)
    ensureSelfConversation(userId)
    const scheduled = store.countScheduledBySender(userId)
    const conversations = store.listConversationsForUser(userId).map((c) => {
      const extra = scheduled[c.id] ? { scheduledCount: scheduled[c.id] } : {}
      if (c.kind === "direct" && !c.isSelf) {
        const peer = store.getDirectPeer(c.id, userId)
        if (peer) return { ...c, ...extra, peer: { id: peer.id, username: peer.username, displayName: peer.displayName, avatar: peer.avatar ?? null, isBot: Boolean(peer.isBot) } }
      }
      return { ...c, ...extra }
    })
    sendJson(ctx.res, 200, { conversations })
  })
  router.get("/api/friends/requests", (ctx) => {
    const userId = requireAuth(ctx)
    const shape = (r: FriendRequestRow) => {
      const otherId = r.fromUser === userId ? r.toUser : r.fromUser
      const other = store.getUserById(otherId)
      return { id: r.id, fromUser: r.fromUser, toUser: r.toUser, status: r.status, createdAt: r.createdAt, username: other?.username ?? null, displayName: other?.displayName ?? null, avatar: other?.avatar ?? null }
    }
    sendJson(ctx.res, 200, { incoming: store.listIncomingFriendRequests(userId).map(shape), outgoing: store.listOutgoingFriendRequests(userId).map(shape) })
  })
  router.post("/api/friends/requests", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const username = String(b.username ?? "").trim()
    if (!username) throw new HttpError(400, "username is required")
    const target = store.getUserByUsername(username)
    if (!target) throw new HttpError(404, "user not found")
    if (target.id === userId) throw new HttpError(400, "you cannot add yourself")
    if (store.isBot(userId)) throw new HttpError(403, "bots cannot send friend requests")
    const existingDirect = store.findDirectConversationBetween(userId, target.id)
    // A bot has no one to accept the request: starting it opens the chat.
    if (target.isBot) {
      rateLimit("bot-start:" + userId, 30, 3600000)
      const conversation = existingDirect ?? createDirectConversation(userId, target.id)
      if (!existingDirect) {
        const me = store.getUserById(userId)
        bus.publishToUsers([userId], { type: "friend.accepted", conversation: { ...conversation, peer: authmod.publicUser(target) } } as unknown as WsEvent)
        botHub.notifyBot(target.id, { type: "conversation_added", conversation: { id: conversation.id, kind: conversation.kind, title: null }, startedBy: me ? { id: me.id, username: me.username, displayName: me.displayName } : { id: userId } })
      }
      sendJson(ctx.res, 200, { status: "accepted", conversation: { ...conversation, peer: authmod.publicUser(target) } })
      return
    }
    if (existingDirect) throw new HttpError(409, "you already have a direct chat with this user")
    const reverse = store.getFriendRequestPair(target.id, userId)
    if (reverse && reverse.status === "pending") {
      const conversation = createDirectConversation(userId, target.id)
      store.deleteFriendRequest(reverse.id)
      const mineAlready = store.getFriendRequestPair(userId, target.id)
      if (mineAlready) store.deleteFriendRequest(mineAlready.id)
      notifyFriendAccepted(userId, target.id, conversation)
      sendJson(ctx.res, 200, { status: "accepted", conversation })
      return
    }
    const existing = store.getFriendRequestPair(userId, target.id)
    const now = new Date().toISOString()
    let requestId: string
    if (existing) { requestId = existing.id; store.setFriendRequestStatus(requestId, "pending") }
    else { requestId = newId("freq"); store.createFriendRequest({ id: requestId, fromUser: userId, toUser: target.id, status: "pending", createdAt: now }) }
    bus.publishToUsers([target.id, userId], { type: "friend.request", requestId, fromUser: userId, toUser: target.id } as unknown as WsEvent)
    sendJson(ctx.res, 201, { status: "pending", requestId })
  })
  router.post("/api/friends/requests/:id/accept", (ctx) => {
    const userId = requireAuth(ctx)
    const request = store.getFriendRequestById(ctx.params.id)
    if (!request || request.toUser !== userId) throw new HttpError(404, "friend request not found")
    if (request.status !== "pending") throw new HttpError(409, "friend request is no longer pending")
    const existing = store.findDirectConversationBetween(request.fromUser, request.toUser)
    const conversation = existing ?? createDirectConversation(request.fromUser, request.toUser)
    store.deleteFriendRequest(request.id)
    notifyFriendAccepted(request.fromUser, request.toUser, conversation)
    sendJson(ctx.res, 200, { conversation })
  })
  router.post("/api/friends/requests/:id/decline", (ctx) => {
    const userId = requireAuth(ctx)
    const request = store.getFriendRequestById(ctx.params.id)
    if (!request || (request.toUser !== userId && request.fromUser !== userId)) throw new HttpError(404, "friend request not found")
    store.deleteFriendRequest(request.id)
    bus.publishToUsers([request.fromUser, request.toUser], { type: "friend.declined", requestId: request.id } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })
  // Disappearing messages: one lifetime per conversation, set by a moderator
  // (or by either side of a direct chat).
  // Link previews: only the sender asks for one, and the result is embedded in
  // the encrypted message, so recipients never reach out to the linked site.
  router.get("/api/link-preview", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("link-preview:" + userId, 60, 60000)
    const url = String(ctx.query.get("url") ?? "")
    if (!url) throw new HttpError(400, "url is required")
    try {
      const preview = await buildLinkPreview(url)
      sendJson(ctx.res, 200, { preview })
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : "preview failed")
    }
  })
  router.get("/api/link-preview/image", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("link-preview-image:" + userId, 60, 60000)
    const url = String(ctx.query.get("url") ?? "")
    if (!url) throw new HttpError(400, "url is required")
    try {
      const image = await fetchPreviewImage(url)
      ctx.res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": String(image.bytes.length),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      })
      ctx.res.end(Buffer.from(image.bytes))
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : "image failed")
    }
  })
  router.post("/api/conversations/:id/ttl", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    const member = requireMember(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation) throw new HttpError(404, "conversation not found")
    if (conversation.kind !== "direct" && member.role !== "owner" && member.role !== "admin") {
      throw new HttpError(403, "only an owner or admin can change the message lifetime")
    }
    const body = await readJson(ctx.req)
    const raw = body.seconds
    let seconds: number | null = null
    if (raw !== null && raw !== undefined && raw !== 0) {
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 60 || value > 31536000) throw new HttpError(400, "seconds must be between 60 and 31536000, or null")
      seconds = Math.floor(value)
    }
    store.setConversationTtl(conversationId, seconds)
    const members = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "conversation.ttl_changed", conversationId, ttlSeconds: seconds } as WsEvent)
    sendJson(ctx.res, 200, { conversationId, ttlSeconds: seconds })
  })
  router.post("/api/conversations/:id/archive", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const b = await readJson(ctx.req)
    const archivedAt = b.archived === false ? null : new Date().toISOString()
    store.setConversationArchived(conversationId, userId, archivedAt)
    bus.publishToUsers([userId], { type: "conversation.state_changed", conversationId, userId, archivedAt } as WsEvent)
    sendJson(ctx.res, 200, { conversationId, archivedAt })
  })
  router.post("/api/conversations/:id/mute", async (ctx) => {
    const userId=requireAuth(ctx); const conversationId=ctx.params.id; requireMember(conversationId,userId); const body=await readJson(ctx.req)
    let mutedUntil: string | null=null
    if(body.mutedUntil!==null && body.mutedUntil!==undefined && body.mutedUntil!=="") { const date=new Date(String(body.mutedUntil)); if(Number.isNaN(date.getTime()) || date.getTime()<=Date.now()) throw new HttpError(400,"mutedUntil must be a future ISO timestamp or null"); mutedUntil=date.toISOString() }
    store.setConversationMuted(conversationId,userId,mutedUntil); bus.publishToUsers([userId],{type:"conversation.muted",conversationId,userId,mutedUntil} as WsEvent); sendJson(ctx.res,200,{conversationId,mutedUntil})
  })
  router.post("/api/conversations/:id/profile", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireModerator(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation || conversation.kind === "direct") throw new HttpError(409, "only groups and channels have an editable profile")
    const b = await readJson(ctx.req)
    if (b.title !== undefined) {
      const title = String(b.title ?? "").trim()
      if (!title || title.length > 80) throw new HttpError(400, "title must contain 1-80 characters")
      store.updateConversationTitle(conversationId, title)
    }
    if (b.avatar !== undefined) {
      const avatarValue = b.avatar === null || b.avatar === "" ? null : String(b.avatar)
      if (avatarValue && avatarValue.length > 700000) throw new HttpError(413, "avatar image is too large")
      if (avatarValue && !isImageDataUrl(avatarValue)) throw new HttpError(400, "avatar must be an image data url")
      store.setConversationAvatar(conversationId, avatarValue)
    }
    const updated = store.getConversation(conversationId)
    const memberIds = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(memberIds, { type: "conversation.profile_updated", conversationId, title: updated?.title ?? null, avatar: updated?.avatar ?? null } as unknown as WsEvent)
    sendJson(ctx.res, 200, { conversation: updated })
  })
  router.get("/api/conversations/:id/draft", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    sendJson(ctx.res, 200, { draft: store.getConversationDraft(conversationId, userId) })
  })
  router.post("/api/conversations/:id/draft", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const b = await readJson(ctx.req)
    const ciphertext = typeof b.ciphertext === "string" ? b.ciphertext : ""
    if (ciphertext.length > 131072) throw new HttpError(413, "encrypted draft exceeds 131072 characters")
    const updatedAt = ciphertext ? new Date().toISOString() : null
    if (ciphertext && updatedAt) store.saveConversationDraft({ conversationId, userId, ciphertext, updatedAt })
    else store.clearConversationDraft(conversationId, userId)
    bus.publishToUsers([userId], { type: "draft.updated", conversationId, userId, ciphertext: ciphertext || null, updatedAt } as WsEvent)
    sendJson(ctx.res, 200, { draft: ciphertext && updatedAt ? { conversationId, userId, ciphertext, updatedAt } : null })
  })
  router.get("/api/conversations/:id/messages", (ctx) => {
    const userId = requireAuth(ctx)
    requireMember(ctx.params.id, userId)
    const limitRaw = Number(ctx.query.get("limit") ?? "50")
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50
    const before = ctx.query.get("before")
    const effective = Math.max(1, Math.min(500, limit))
    // A window around one message, for opening a search hit in its chat.
    const around = ctx.query.get("around")
    if (around) {
      const windowed = store.listMessagesAround(ctx.params.id, around, effective)
      if (!windowed) throw new HttpError(404, "message not found")
      sendJson(ctx.res, 200, { messages: windowed.messages.map(toEnvelope), hasMore: windowed.hasOlder, hasNewer: windowed.hasNewer })
      return
    }
    const after = ctx.query.get("after")
    if (after) {
      const newer = store.listMessagesAfter(ctx.params.id, after, effective).map(toEnvelope)
      sendJson(ctx.res, 200, { messages: newer, hasMore: true, hasNewer: newer.length === effective })
      return
    }
    const messages = store.listMessages(ctx.params.id, { limit: effective, before }).map(toEnvelope)
    sendJson(ctx.res, 200, { messages, hasMore: messages.length === effective, hasNewer: false })
  })
  router.post("/api/conversations/:id/messages", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanSend(conversationId, userId)
    const b = await readJson(ctx.req)
    const ciphertext = String(b.ciphertext ?? "")
    if (!ciphertext) throw new HttpError(400, "ciphertext is required")
    if (ciphertext.length > 262144) throw new HttpError(413, "message is too large")
    assertCurrentKey(store, conversationId, ciphertext)
    const replyTo = b.replyTo != null ? String(b.replyTo) : null
    if (replyTo && store.getMessage(replyTo)?.conversationId !== conversationId) throw new HttpError(404, "message not found")
    const message: MessageRow = {
      id: newId("msg"),
      conversationId,
      senderId: userId,
      ciphertext,
      replyTo,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      silent: b.silent === true,
    }
    deliverMessage(message)
    sendJson(ctx.res, 201, { message: toEnvelope(message) })
  })
  // --- encrypted polls and quizzes ---
  router.get("/api/conversations/:id/polls", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    sendJson(ctx.res, 200, { polls: store.listPollSnapshots(conversationId, userId).map(toPollSummary) })
  })
  router.post("/api/conversations/:id/polls", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanSend(conversationId, userId)
    const body = await readJson(ctx.req)
    const ciphertext = String(body.ciphertext ?? "")
    if (!ciphertext || ciphertext.length > 131072) throw new HttpError(400, "encrypted poll payload must contain 1-131072 characters")
    assertCurrentKey(store, conversationId, ciphertext)
    const optionCount = Number(body.optionCount)
    if (!Number.isInteger(optionCount) || optionCount < 2 || optionCount > 10) throw new HttpError(400, "optionCount must be an integer from 2 to 10")
    const multipleChoice = body.multipleChoice === true
    const quiz = body.quiz === true
    if (multipleChoice && quiz) throw new HttpError(400, "a quiz accepts one answer")
    const now = new Date().toISOString()
    const message: MessageRow = {
      id: newId("msg"),
      conversationId,
      senderId: userId,
      ciphertext,
      replyTo: null,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
    }
    const poll: PollRow = { messageId: message.id, conversationId, creatorId: userId, optionCount, multipleChoice, quiz, closedAt: null, createdAt: now }
    store.createPollMessage(message, poll)
    const snapshot = store.getPollSnapshot(message.id, userId)
    if (!snapshot) throw new HttpError(500, "poll was not persisted")
    const members = store.listMembers(conversationId).map((member) => member.userId)
    bus.publishToUsers(members, { type: "message.created", message: toEnvelope(message) })
    if (body.silent !== true) notifyMessagePush(conversationId, userId, members)
    notifyBots(conversationId, { type: "message", conversationId, message: toEnvelope(message), sender: senderView(userId), poll: toPollSummary(snapshot) }, userId)
    publishPollUpdate(conversationId, snapshot)
    sendJson(ctx.res, 201, { message: toEnvelope(message), poll: toPollSummary(snapshot) })
  })
  router.post("/api/conversations/:id/polls/:mid/vote", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    const member = requireMember(conversationId, userId)
    if (member.role === "restricted") throw new HttpError(403, "your role is read-only")
    const poll = store.getPoll(ctx.params.mid)
    if (!poll || poll.conversationId !== conversationId) throw new HttpError(404, "poll not found")
    if (poll.closedAt) throw new HttpError(409, "poll is closed")
    const body = await readJson(ctx.req)
    if (!Array.isArray(body.optionIndexes)) throw new HttpError(400, "optionIndexes must be an array")
    const indexes = Array.from(new Set(body.optionIndexes.map((value: unknown) => Number(value))))
    if (indexes.length === 0 || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= poll.optionCount)) {
      throw new HttpError(400, "optionIndexes must select valid poll options")
    }
    if (!poll.multipleChoice && indexes.length !== 1) throw new HttpError(400, "this poll accepts one option")
    indexes.sort((a, b) => a - b)
    store.setPollVote(poll.messageId, userId, indexes, new Date().toISOString())
    const snapshot = store.getPollSnapshot(poll.messageId, userId)
    if (!snapshot) throw new HttpError(500, "poll was not persisted")
    publishPollUpdate(conversationId, snapshot)
    sendJson(ctx.res, 200, { poll: toPollSummary(snapshot) })
  })
  router.post("/api/conversations/:id/polls/:mid/close", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    const member = requireMember(conversationId, userId)
    const poll = store.getPoll(ctx.params.mid)
    if (!poll || poll.conversationId !== conversationId) throw new HttpError(404, "poll not found")
    const conversation = store.getConversation(conversationId)
    const isAdmin = conversation?.kind !== "direct" && (member.role === "owner" || member.role === "admin")
    if (poll.creatorId !== userId && !isAdmin) throw new HttpError(403, "only the poll creator or a moderator can close this poll")
    if (!poll.closedAt) store.closePoll(poll.messageId, new Date().toISOString())
    const snapshot = store.getPollSnapshot(poll.messageId, userId)
    if (!snapshot) throw new HttpError(500, "poll was not persisted")
    publishPollUpdate(conversationId, snapshot)
    sendJson(ctx.res, 200, { poll: toPollSummary(snapshot) })
  })

  router.get("/api/conversations/:id/receipts", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    sendJson(ctx.res, 200, { receipts: store.listReceiptsForConversation(conversationId) })
  })
  router.post("/api/conversations/:id/receipts", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const b = await readJson(ctx.req)
    const messageId = String(b.messageId ?? "")
    if (!messageId) throw new HttpError(400, "messageId is required")
    if (store.getMessage(messageId)?.conversationId !== conversationId) throw new HttpError(404, "message not found")
    const stateInput = String(b.state ?? "read")
    const state = stateInput === "sent" || stateInput === "delivered" || stateInput === "read" ? stateInput : "read"
    const at = new Date().toISOString()
    if (state === "read" && store.isGhostMode(userId)) { sendJson(ctx.res, 200, { ok: true, hidden: true }); return }
    store.upsertReceipt(messageId, userId, state, at)
    const members = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "receipt.updated", messageId, userId, state, at } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })

  router.post("/api/conversations/:id/messages/:mid/edit", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const existing = store.getMessage(ctx.params.mid)
    if (!existing || existing.conversationId !== conversationId) throw new HttpError(404, "message not found")
    if (existing.senderId !== userId) throw new HttpError(403, "only the author can edit a message")
    if (existing.deletedAt) throw new HttpError(409, "message is deleted")
    if (store.getPoll(existing.id)) throw new HttpError(409, "poll messages cannot be edited")
    const b = await readJson(ctx.req)
    const ciphertext = String(b.ciphertext ?? "")
    if (!ciphertext) throw new HttpError(400, "ciphertext is required")
    const editedAt = new Date().toISOString()
    if (ciphertext.length > 262144) throw new HttpError(413, "message is too large")
    assertCurrentKey(store, conversationId, ciphertext)
    store.editMessage(existing.id, ciphertext, editedAt)
    const updated = store.getMessage(existing.id) as MessageRow
    publishMessageUpdated(updated)
    sendJson(ctx.res, 200, { message: toEnvelope(updated) })
  })
  router.post("/api/conversations/:id/messages/:mid/delete", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const existing = store.getMessage(ctx.params.mid)
    if (!existing || existing.conversationId !== conversationId) throw new HttpError(404, "message not found")
    if (existing.senderId !== userId) throw new HttpError(403, "only the author can delete a message")
    store.softDeleteMessage(existing.id, new Date().toISOString())
    publishMessageDeleted(conversationId, existing.id)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/conversations/:id/messages/:mid/save", async (ctx) => {
    const userId=requireAuth(ctx); const conversationId=ctx.params.id; requireMember(conversationId,userId); const message=store.getMessage(ctx.params.mid)
    if(!message || message.conversationId!==conversationId) throw new HttpError(404,"message not found")
    const body=await readJson(ctx.req); const active=body.active===undefined?true:Boolean(body.active); let savedAt: string | null=null
    if(active) { if(message.deletedAt) throw new HttpError(409,"deleted messages cannot be saved"); savedAt=new Date().toISOString(); store.saveMessageForUser(userId,message.id,savedAt) } else store.unsaveMessageForUser(userId,message.id)
    bus.publishToUsers([userId],{type:"message.saved",conversationId,messageId:message.id,userId,savedAt,active} as WsEvent); sendJson(ctx.res,200,{ok:true,savedAt})
  })
  router.get("/api/conversations/:id/messages/:mid/comments", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const parent = store.getMessage(ctx.params.mid)
    if (!parent || parent.conversationId !== conversationId) throw new HttpError(404, "message not found")
    sendJson(ctx.res, 200, { comments: store.listComments(conversationId, parent.id).map(toEnvelope) })
  })
  router.post("/api/conversations/:id/messages/:mid/comments", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanReact(conversationId, userId)
    const parent = store.getMessage(ctx.params.mid)
    if (!parent || parent.conversationId !== conversationId) throw new HttpError(404, "message not found")
    if (parent.replyTo) throw new HttpError(400, "comments can only be attached to top-level posts")
    const b = await readJson(ctx.req)
    const ciphertext = String(b.ciphertext ?? "")
    if (!ciphertext) throw new HttpError(400, "ciphertext is required")
    if (ciphertext.length > 262144) throw new HttpError(413, "message is too large")
    assertCurrentKey(store, conversationId, ciphertext)
    const message: MessageRow = {
      id: newId("msg"),
      conversationId,
      senderId: userId,
      ciphertext,
      replyTo: parent.id,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      silent: b.silent === true,
    }
    deliverMessage(message)
    sendJson(ctx.res, 201, { message: toEnvelope(message) })
  })
  router.get("/api/conversations/:id/reactions", (ctx) => {
    const userId = requireAuth(ctx)
    requireMember(ctx.params.id, userId)
    sendJson(ctx.res, 200, { reactions: store.listReactions(ctx.params.id) })
  })
  router.post("/api/conversations/:id/messages/:mid/reactions", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanReact(conversationId, userId)
    const existing = store.getMessage(ctx.params.mid)
    if (!existing || existing.conversationId !== conversationId) throw new HttpError(404, "message not found")
    const b = await readJson(ctx.req)
    const emoji = String(b.emoji ?? "").slice(0, 24)
    if (!emoji) throw new HttpError(400, "emoji is required")
    const active = b.active === undefined ? true : Boolean(b.active)
    const at = new Date().toISOString()
    if (active) store.addReaction(existing.id, userId, emoji, at)
    else store.removeReaction(existing.id, userId, emoji)
    const members = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "reaction.updated", conversationId, messageId: existing.id, userId, emoji, active } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.get("/api/conversations/:id/pinned", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    sendJson(ctx.res, 200, { pinned: store.listPinnedMessages(conversationId) })
  })
  router.post("/api/conversations/:id/messages/:mid/pin", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireModerator(conversationId, userId)
    const message = store.getMessage(ctx.params.mid)
    if (!message || message.conversationId !== conversationId) throw new HttpError(404, "message not found")
    if (message.deletedAt) throw new HttpError(409, "deleted messages cannot be pinned")
    const b = await readJson(ctx.req)
    const active = b.active === undefined ? true : Boolean(b.active)
    const pinnedAt = active ? new Date().toISOString() : null
    if (active && pinnedAt) store.pinMessage({ conversationId, messageId: message.id, pinnedBy: userId, pinnedAt })
    else store.unpinMessage(conversationId, message.id)
    const members = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "message.pinned", conversationId, messageId: message.id, pinnedBy: userId, pinnedAt, active } as WsEvent)
    sendJson(ctx.res, 200, { ok: true, pinnedAt })
  })
  router.post("/api/conversations/:id/typing", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanSend(conversationId, userId)
    const others = store
      .listMembers(conversationId)
      .map((m) => m.userId)
      .filter((id) => id !== userId)
    bus.publishToUsers(others, { type: "typing", conversationId, userId } as unknown as WsEvent)
    sendJson(ctx.res, 202, { ok: true })
  })

  // --- calls (WebRTC voice signaling relay) ---
  // The server never handles audio media. It validates membership and relays
  // call control plus WebRTC signaling (SDP/ICE) between members via the bus.
  router.get("/api/conversations/:id/call", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    if (store.getConversation(conversationId)?.kind === "channel") { sendJson(ctx.res, 200, { call: null, iceServers: [] }); return }
    sendJson(ctx.res, 200, { call: calls.get(conversationId), iceServers: iceServersFromEnv() })
  })
  router.post("/api/conversations/:id/call/join", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanSend(conversationId, userId)
    if (store.getConversation(conversationId)?.kind === "channel") throw new HttpError(403, "calls are disabled in channels")
    const memberIds = store.listMembers(conversationId).map((m) => m.userId)
    if (store.getConversation(conversationId)?.kind === "direct") {
      const peer = memberIds.find((id) => id !== userId)
      if (peer && store.isBot(peer)) throw new HttpError(403, "bots cannot take calls")
      // Joining a call the other side started is always allowed; only ringing
      // someone who does not take calls from you is refused.
      const ringing = !calls.get(conversationId)
      if (peer && ringing && !privacyAllows(peer, userId, "calls")) {
        throw new HttpError(403, "this person does not accept calls from you")
      }
    }
    const now = new Date().toISOString()
    const { state, created, alreadyIn } = calls.join(conversationId, userId, "audio", newId("call"), now)
    const others = memberIds.filter((id) => id !== userId)
    // Ringing is what the call setting governs: someone whose settings do not
    // accept calls from the caller is simply not rung. They can still open the
    // chat and join the call themselves.
    const rung = others.filter((id) => privacyAllows(id, userId, "calls"))
    if (created) {
      bus.publishToUsers(rung, { type: "call.invite", conversationId, callId: state.callId, from: userId, media: "audio", at: now } as WsEvent)
    }
    if (created) notifyCallPush(conversationId, userId, rung)
    if (!alreadyIn) {
      const existing = state.participants.filter((id) => id !== userId)
      bus.publishToUsers(existing, { type: "call.joined", conversationId, callId: state.callId, userId } as WsEvent)
    }
    bus.publishToUsers(state.participants, { type: "call.participants", conversationId, callId: state.callId, participants: state.participants } as WsEvent)
    sendJson(ctx.res, 200, { call: state, iceServers: iceServersFromEnv() })
  })
  router.post("/api/conversations/:id/call/leave", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const memberIds = store.listMembers(conversationId).map((m) => m.userId)
    const { state, removed, ended, callId } = calls.leave(conversationId, userId)
    if (removed && callId) {
      const others = memberIds.filter((id) => id !== userId)
      bus.publishToUsers(others, { type: "call.left", conversationId, callId, userId } as WsEvent)
      if (ended) {
        bus.publishToUsers(memberIds, { type: "call.ended", conversationId, callId } as WsEvent)
      } else if (state) {
        bus.publishToUsers(state.participants, { type: "call.participants", conversationId, callId, participants: state.participants } as WsEvent)
      }
    }
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/conversations/:id/call/signal", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    if (store.getConversation(conversationId)?.kind === "channel") throw new HttpError(403, "calls are disabled in channels")
    const b = await readJson(ctx.req)
    const to = String(b.to ?? "")
    const callId = String(b.callId ?? "")
    if (!to) throw new HttpError(400, "signal target 'to' is required")
    if (!store.getMember(conversationId, to)) throw new HttpError(404, "target is not a member of this conversation")
    bus.publishToUsers([to], { type: "call.signal", conversationId, callId, from: userId, to, data: b.data ?? null } as WsEvent)
    sendJson(ctx.res, 202, { ok: true })
  })
  router.get("/api/conversations/:id/files", (ctx) => {
		const userId = requireAuth(ctx)
		requireMember(ctx.params.id, userId)
		const files = store.listFileAssetsByConversation(ctx.params.id).map((asset) => ({
			asset,
			replica: store.getReplicaByAsset(asset.id),
		}))
		sendJson(ctx.res, 200, { files })
	})

	// --- files (local-first lifecycle) ---
  const loadAssetAndReplica = (fileId: string, userId: string) => {
    const asset = store.getFileAsset(fileId)
    if (!asset) throw new HttpError(404, "file not found")
    requireMember(asset.conversationId, userId)
    const replica = store.getReplicaByAsset(fileId)
    if (!replica) throw new HttpError(404, "replica not found")
    return { asset, replica }
  }
  const applyTransition = (ctx: Ctx, transition: (record: ReplicaRecord) => ReplicaRecord): void => {
    const userId = requireAuth(ctx)
    const { asset, replica } = loadAssetAndReplica(ctx.params.id, userId)
    const updated = recordToRow(transition(rowToRecord(replica)))
    store.saveReplica(updated)
    publishReplica(asset.conversationId, asset.id, updated)
    sendJson(ctx.res, 200, { replica: updated })
  }
  // Registers an attachment (people and bots alike): the name and type arrive
  // sealed with the conversation key, the bytes follow with storeFileBlob.
  const createFileAssetFor = (userId: string, b: Record<string, unknown>) => {
    const conversationId = String(b.conversationId ?? "")
    requireMember(conversationId, userId)
    const now = new Date().toISOString()
    const size = Number(b.size ?? 0)
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "file size must be a non-negative integer")
    if (size > limits.maxFileBytes) throw new HttpError(413, "File exceeds the maximum size of " + limits.maxFileBytes + " bytes")
    const allowance = uploadAllowance(userId)
    if (size > allowance.bytes) throw new HttpError(413, allowance.reason)
    const asset = {
      id: newId("file"),
      conversationId,
      ownerId: userId,
      name: String(b.name ?? "file").slice(0, 255),
      mime: String(b.mime ?? "application/octet-stream").slice(0, 127),
      size,
      manifestJson: JSON.stringify(b.manifest ?? null),
      createdAt: now,
    }
    store.createFileAsset(asset)
    const replica = recordToRow(lifecycle.create(newId("rep"), asset.id))
    store.createReplica(replica)
    publishReplica(conversationId, asset.id, replica)
    return { asset, replica }
  }
  router.post("/api/files", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    sendJson(ctx.res, 201, createFileAssetFor(userId, b))
  })
  router.get("/api/files/:id", (ctx) => {
    const userId = requireAuth(ctx)
    const { asset, replica } = loadAssetAndReplica(ctx.params.id, userId)
    sendJson(ctx.res, 200, { asset, replica })
  })
  router.post("/api/files/:id/backup/begin", (ctx) => applyTransition(ctx, (r) => lifecycle.beginRemoveLocalCopy(r)))
  router.post("/api/files/:id/backup/complete", (ctx) => {
    const userId = requireAuth(ctx)
    const { asset, replica } = loadAssetAndReplica(ctx.params.id, userId)
    if (!hasBlob(asset.id)) {
      throw new HttpError(409, "encrypted backup bytes must be uploaded before confirming")
    }
    const backupBytes = blobByteLength(asset.id)
    const used = store
      .listBackupAssetIdsForOwner(asset.ownerId)
      .reduce((total, backupAssetId) => total + blobByteLength(backupAssetId), 0)
    if (used + backupBytes > limits.tempBackupQuotaBytes) {
      throw new HttpError(413, "Backup quota exceeded: " + (used + backupBytes) + " > " + limits.tempBackupQuotaBytes + " bytes")
    }
    const updated = recordToRow(lifecycle.completeUpload(rowToRecord(replica)))
    store.saveReplica(updated)
    publishReplica(asset.conversationId, asset.id, updated)
    sendJson(ctx.res, 200, { replica: updated })
  })
  router.post("/api/files/:id/backup/fail", (ctx) => {
    const userId = requireAuth(ctx)
    const { asset, replica } = loadAssetAndReplica(ctx.params.id, userId)
    deleteBlob(asset.id)
    const updated = recordToRow(lifecycle.failUpload(rowToRecord(replica)))
    store.saveReplica(updated)
    publishReplica(asset.conversationId, asset.id, updated)
    sendJson(ctx.res, 200, { replica: updated })
  })
  router.post("/api/files/:id/restore/begin", (ctx) => applyTransition(ctx, (r) => lifecycle.beginRestore(r)))
  router.post("/api/files/:id/restore/complete", (ctx) => {
    const userId = requireAuth(ctx)
    const { asset, replica } = loadAssetAndReplica(ctx.params.id, userId)
    const updated = recordToRow(lifecycle.completeRestore(rowToRecord(replica)))
    deleteBlob(asset.id)
    store.saveReplica(updated)
    publishReplica(asset.conversationId, asset.id, updated)
    sendJson(ctx.res, 200, { replica: updated })
  })
  router.post("/api/files/:id/restore/fail", (ctx) => applyTransition(ctx, (r) => lifecycle.failRestore(r)))
  router.post("/api/files/:id/lost", (ctx) => applyTransition(ctx, (r) => lifecycle.markLocalLost(r)))

  const storeFileBlob = async (userId: string, fileId: string, req: Ctx["req"]): Promise<number> => {
    const { asset } = loadAssetAndReplica(fileId, userId)
    if (asset.ownerId !== userId) throw new HttpError(403, "only the uploader can store blob bytes")
    const allowance = uploadAllowance(userId, asset.id)
    const limit = Math.min(limits.maxBlobBytes, allowance.bytes)
    const declared = Number(req.headers["content-length"] ?? 0)
    const overLimit = () => limit < limits.maxBlobBytes ? allowance.reason : "blob exceeds the maximum size of " + limits.maxBlobBytes + " bytes"
    if (limit <= 0 || (Number.isFinite(declared) && declared > limit)) {
      req.resume()
      throw new HttpError(413, overLimit())
    }
    try {
      return await saveBlobFromStream(asset.id, req, limit)
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw new HttpError(413, overLimit())
      throw error
    }
  }
  router.post("/api/files/:id/blob", async (ctx) => {
    const userId = requireAuth(ctx)
    const bytes = await storeFileBlob(userId, ctx.params.id, ctx.req)
    sendJson(ctx.res, 200, { ok: true, bytes })
  })
  router.get("/api/files/:id/blob", (ctx) => {
    const userId = requireAuth(ctx)
    const { asset } = loadAssetAndReplica(ctx.params.id, userId)
    const bytes = readBlob(asset.id)
    if (!bytes) throw new HttpError(404, "blob not found")
    sendBytes(ctx.res, 200, bytes)
  })

  router.post("/api/me/publicKey", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const publicKey = String(b.publicKey ?? "")
    if (!publicKey) throw new HttpError(400, "publicKey is required")
    const keyChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-"
    if (publicKey.length > 2000 || Array.from(publicKey).some((ch: string) => keyChars.indexOf(ch) < 0)) {
      throw new HttpError(400, "publicKey format is invalid")
    }
    // Once the account has an account key, its identity only changes through
    // the key system itself; a device that shows up with some other key (an
    // old build, a second browser) would lock the others out.
    const current = store.getUserById(userId)
    if (store.getAccountKey(userId)) {
      if (current && (current.publicKey === publicKey || !current.publicKey)) {
        if (!current.publicKey) store.setUserPublicKey(userId, publicKey)
        sendJson(ctx.res, 200, { ok: true })
        return
      }
      throw new HttpError(409, "this account's keys are managed by the account key; unlock them instead of replacing the identity")
    }
    // Before that, the password-protected key backup is the identity of record.
    const registeredBackup = store.getKeyBackup(userId)
    if (registeredBackup && registeredBackup.publicKey && registeredBackup.publicKey !== publicKey) {
      throw new HttpError(409, "a different public key is already registered for this account; restore your existing key from the key backup instead")
    }
    store.setUserPublicKey(userId, publicKey)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.get("/api/me/keybackup", (ctx) => {
    const userId = requireAuth(ctx)
    const backup = store.getKeyBackup(userId)
    sendJson(ctx.res, 200, { backup: backup ?? null })
  })
  router.post("/api/me/keybackup", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const salt = String(b.salt ?? "")
    const iv = String(b.iv ?? "")
    const ciphertext = String(b.ciphertext ?? "")
    const publicKey = String(b.publicKey ?? "")
    const iterations = Math.floor(Number(b.iterations ?? 0))
    if (!salt || !iv || !ciphertext || !publicKey) throw new HttpError(400, "backup is incomplete")
    if (!(iterations >= 50000 && iterations <= 2000000)) throw new HttpError(400, "iterations out of range")
    if (salt.length > 256 || iv.length > 256 || ciphertext.length > 4096 || publicKey.length > 2000) {
      throw new HttpError(400, "backup is too large")
    }
    // The legacy backup may only ever describe the identity the account uses.
    const owner = store.getUserById(userId)
    if (store.getAccountKey(userId) && owner && owner.publicKey && owner.publicKey !== publicKey) {
      throw new HttpError(409, "this backup does not match the account's identity key")
    }
    store.putKeyBackup({
      userId,
      salt,
      iv,
      ciphertext,
      iterations,
      publicKey,
      updatedAt: new Date().toISOString(),
    })
    store.setUserPublicKey(userId, publicKey)
    sendJson(ctx.res, 201, { ok: true })
  })
  router.get("/api/conversations/:id/members", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const members = store.listMembers(conversationId).map((m) => {
      const u = store.getUserById(m.userId)
      return {
        userId: m.userId,
        role: m.role,
        username: u ? u.username : null,
        displayName: u ? u.displayName : null,
        publicKey: u ? u.publicKey : null,
        avatar: u ? u.avatar : null,
        isBot: Boolean(u?.isBot),
      }
    })
    sendJson(ctx.res, 200, { members })
  })
  router.get("/api/presence", (ctx) => {
    const userId = requireAuth(ctx)
    const checked = new Set<string>([userId])
    const ids: string[] = []
    const lastSeen: Record<string, string> = {}
    for (const conversationId of store.listConversationIdsForUser(userId)) {
      for (const member of store.listMembers(conversationId)) {
        if (checked.has(member.userId)) continue
        checked.add(member.userId)
        if (bus.isUserVisible(member.userId) && canSeeOnline(member.userId, userId)) ids.push(member.userId)
        const at = lastSeenFor(member.userId, userId)
        if (at) lastSeen[member.userId] = at
      }
    }
    sendJson(ctx.res, 200, { onlineUserIds: ids, lastSeen })
  })
  router.get("/api/conversations/:id/presence", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const members = store.listMembers(conversationId)
    const onlineUserIds = members
      .filter((member) => bus.isUserVisible(member.userId) && (member.userId === userId || canSeeOnline(member.userId, userId)))
      .map((member) => member.userId)
    const lastSeen: Record<string, string> = {}
    for (const member of members) {
      if (member.userId === userId) continue
      const at = lastSeenFor(member.userId, userId)
      if (at) lastSeen[member.userId] = at
    }
    sendJson(ctx.res, 200, { onlineUserIds, lastSeen })
  })
  router.post("/api/conversations/:id/members/:memberId/role", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    const actor = requireMember(conversationId, userId)
    const conversation = store.getConversation(conversationId)
    if (!conversation || conversation.kind === "direct") throw new HttpError(409, "roles are managed only in groups and channels")
    if (actor.role !== "owner") throw new HttpError(403, "only the owner can change roles")
    const target = store.getMember(conversationId, ctx.params.memberId)
    if (!target) throw new HttpError(404, "member not found")
    if (target.role === "owner") throw new HttpError(409, "the owner role cannot be changed")
    const b = await readJson(ctx.req)
    const requested = String(b.role ?? "")
    const role: MemberRole | null = requested === "admin" || requested === "member" || requested === "restricted" ? requested : null
    if (!role) throw new HttpError(400, "role must be admin, member, or restricted")
    store.setMemberRole(conversationId, target.userId, role)
    const members = store.listMembers(conversationId).map((m) => m.userId)
    bus.publishToUsers(members, { type: "member.role_changed", conversationId, userId: target.userId, role } as WsEvent)
    sendJson(ctx.res, 200, { member: { ...target, role } })
  })
  // --- first-generation conversation keys --------------------------------------
  // Clients from before key system v2 read and write one wrapped copy per
  // member. Those copies are the "legacy" epoch now; the routes keep working so
  // an old build that is still open never loses access. The destructive reset
  // they offered (replace everyone's key, losing the history) is refused.
  router.post("/api/conversations/:id/keys", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const b = await readJson(ctx.req)
    if (b.rotate === true) throw new HttpError(409, "resetting the conversation key is no longer supported; update the app")
    const entries = Array.isArray(b.entries) ? b.entries : []
    const memberIds = new Set(store.listMembers(conversationId).map((m) => m.userId))
    const now = new Date().toISOString()
    const existing = new Set(store.listKeyShareMemberIds(conversationId, "legacy"))
    let count = 0
    for (const e of entries) {
      const memberId = String(e.memberId ?? "")
      const ephemeralPublicKey = String(e.ephemeralPublicKey ?? "")
      const iv = String(e.iv ?? "")
      const ciphertext = String(e.ciphertext ?? "")
      if (!memberId || !ephemeralPublicKey || !iv || !ciphertext) continue
      if (ephemeralPublicKey.length > 400 || iv.length > 64 || ciphertext.length > 512) continue
      if (!memberIds.has(memberId) || existing.has(memberId)) continue
      if (count === 0) store.ensureLegacyEpoch(conversationId, userId, now)
      const member = store.getUserById(memberId)
      store.putKeyShares([{ conversationId, keyId: "legacy", memberId, ephemeralPublicKey, iv, ciphertext, recipientKey: member?.publicKey ?? null, createdBy: userId, createdAt: now }])
      store.putConversationKey({ conversationId, memberId, ephemeralPublicKey, iv, ciphertext, createdBy: userId, createdAt: now })
      count += 1
    }
    sendJson(ctx.res, 201, { ok: true, count })
  })
  router.post("/api/conversations/:id/keys/reset", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    store.deleteKeyShare(conversationId, "legacy", userId)
    store.deleteConversationKeyForMember(conversationId, userId)
    const others = store.listMembers(conversationId).map((m) => m.userId).filter((id) => id !== userId)
    bus.publishToUsers(others, { type: "keys.shares_needed", conversationId } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.get("/api/conversations/:id/keys/mine", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const share = store.getKeyShare(conversationId, "legacy", userId)
    const entry = share
      ? { conversationId, memberId: userId, ephemeralPublicKey: share.ephemeralPublicKey, iv: share.iv, ciphertext: share.ciphertext, createdBy: share.createdBy, createdAt: share.createdAt }
      : store.getConversationKeyForMember(conversationId, userId)
    sendJson(ctx.res, 200, { entry: entry ?? null })
  })
  router.get("/api/conversations/:id/keys/status", (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const memberIds = store.listKeyShareMemberIds(conversationId, "legacy")
    sendJson(ctx.res, 200, { memberIds, hasKeys: memberIds.length > 0, mine: memberIds.indexOf(userId) >= 0 })
  })

  // --- scheduled messages ---------------------------------------------------------
  // Sealed now, delivered by the server at the chosen time even if every device
  // of the sender is offline by then. Only the sender sees them until then.
  const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600 * 1000
  const parseSendAt = (value: unknown): string => {
    const at = new Date(String(value ?? ""))
    if (Number.isNaN(at.getTime())) throw new HttpError(400, "sendAt must be an ISO timestamp")
    if (at.getTime() < Date.now() + 5000) throw new HttpError(400, "pick a time in the future")
    if (at.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new HttpError(400, "messages can be scheduled up to a year ahead")
    return at.toISOString()
  }
  const scheduledView = (row: ReturnType<Store["listScheduledMessages"]>[number]) => ({
    id: row.id,
    conversationId: row.conversationId,
    ciphertext: row.ciphertext,
    replyTo: row.replyTo,
    silent: row.silent,
    sendAt: row.sendAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  const announceScheduled = (userId: string, conversationId: string): void => {
    bus.publishToUsers([userId], { type: "scheduled.updated", conversationId, count: store.countScheduledInConversation(conversationId, userId) } as unknown as WsEvent)
  }
  const ownScheduled = (ctx: Ctx, userId: string) => {
    const conversationId = ctx.params.id
    requireMember(conversationId, userId)
    const row = store.getScheduledMessage(ctx.params.sid)
    if (!row || row.conversationId !== conversationId || row.senderId !== userId) throw new HttpError(404, "scheduled message not found")
    return row
  }
  router.get("/api/conversations/:id/scheduled", (ctx) => {
    const userId = requireAuth(ctx)
    requireMember(ctx.params.id, userId)
    sendJson(ctx.res, 200, { scheduled: store.listScheduledMessages(ctx.params.id, userId).map(scheduledView) })
  })
  router.post("/api/conversations/:id/scheduled", async (ctx) => {
    const userId = requireAuth(ctx)
    const conversationId = ctx.params.id
    requireCanSend(conversationId, userId)
    rateLimit("schedule:" + userId, 120, 3600000)
    const b = await readJson(ctx.req)
    const ciphertext = String(b.ciphertext ?? "")
    if (!ciphertext || ciphertext.length > 262144) throw new HttpError(400, "ciphertext must contain 1-262144 characters")
    assertCurrentKey(store, conversationId, ciphertext)
    const replyTo = b.replyTo != null ? String(b.replyTo) : null
    if (replyTo && store.getMessage(replyTo)?.conversationId !== conversationId) throw new HttpError(404, "message not found")
    if (store.countScheduledInConversation(conversationId, userId) >= 100) throw new HttpError(409, "at most 100 scheduled messages per chat")
    const now = new Date().toISOString()
    const row = { id: newId("sched"), conversationId, senderId: userId, ciphertext, replyTo, silent: b.silent === true, sendAt: parseSendAt(b.sendAt), createdAt: now, updatedAt: now }
    store.createScheduledMessage(row)
    announceScheduled(userId, conversationId)
    sendJson(ctx.res, 201, { scheduled: scheduledView(row) })
  })
  router.post("/api/conversations/:id/scheduled/:sid/update", async (ctx) => {
    const userId = requireAuth(ctx)
    const row = ownScheduled(ctx, userId)
    const b = await readJson(ctx.req)
    const patch: { ciphertext?: string; sendAt?: string; silent?: boolean } = {}
    if (b.ciphertext !== undefined) {
      const ciphertext = String(b.ciphertext ?? "")
      if (!ciphertext || ciphertext.length > 262144) throw new HttpError(400, "ciphertext must contain 1-262144 characters")
      patch.ciphertext = ciphertext
    }
    if (b.sendAt !== undefined) patch.sendAt = parseSendAt(b.sendAt)
    if (b.silent !== undefined) patch.silent = b.silent === true
    store.updateScheduledMessage(row.id, patch, new Date().toISOString())
    announceScheduled(userId, row.conversationId)
    sendJson(ctx.res, 200, { scheduled: scheduledView(store.getScheduledMessage(row.id) as NonNullable<ReturnType<Store["getScheduledMessage"]>>) })
  })
  router.post("/api/conversations/:id/scheduled/:sid/delete", (ctx) => {
    const userId = requireAuth(ctx)
    const row = ownScheduled(ctx, userId)
    store.deleteScheduledMessage(row.id)
    announceScheduled(userId, row.conversationId)
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/conversations/:id/scheduled/:sid/send-now", (ctx) => {
    const userId = requireAuth(ctx)
    const row = ownScheduled(ctx, userId)
    requireCanSend(row.conversationId, userId)
    const message = deliverScheduledRow(row, Date.now())
    announceScheduled(userId, row.conversationId)
    sendJson(ctx.res, 200, { message: message ? toEnvelope(message) : null })
  })
  // Delivered with the time it actually goes out. The sender may have left or
  // lost the right to post meanwhile; then it is dropped, not delivered.
  const deliverScheduledRow = (row: ReturnType<Store["listScheduledMessages"]>[number], now: number): MessageRow | null => {
    if (!store.deleteScheduledMessage(row.id)) return null
    const member = store.getMember(row.conversationId, row.senderId)
    const conversation = store.getConversation(row.conversationId)
    if (!member || !conversation || member.role === "restricted") return null
    if (conversation.kind === "channel" && member.role !== "owner" && member.role !== "admin") return null
    const replyTo = row.replyTo && store.getMessage(row.replyTo)?.conversationId === row.conversationId ? row.replyTo : null
    const message: MessageRow = {
      id: newId("msg"),
      conversationId: row.conversationId,
      senderId: row.senderId,
      ciphertext: row.ciphertext,
      replyTo,
      createdAt: new Date(now).toISOString(),
      editedAt: null,
      deletedAt: null,
      silent: row.silent,
    }
    deliverMessage(message)
    return message
  }
  const deliverDueScheduled = (now = Date.now()): number => {
    let delivered = 0
    const touched = new Map<string, Set<string>>()
    for (const row of store.listDueScheduledMessages(new Date(now).toISOString())) {
      try {
        if (deliverScheduledRow(row, now)) delivered += 1
      } catch (error) {
        console.error("[api] scheduled delivery failed", row.id, error)
      }
      const set = touched.get(row.senderId) ?? new Set<string>()
      set.add(row.conversationId)
      touched.set(row.senderId, set)
    }
    for (const [senderId, conversations] of touched) {
      for (const conversationId of conversations) announceScheduled(senderId, conversationId)
    }
    return delivered
  }

  // --- search -------------------------------------------------------------------------
  // The server cannot search encrypted messages, so it hands the ciphertext of
  // all of the user's chats out page by page; the device decrypts and matches.
  router.get("/api/search/messages", (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("search-corpus:" + userId, 600, 600000)
    const limitRaw = Number(ctx.query.get("limit") ?? "500")
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : 500
    const before = ctx.query.get("before")
    const conversationId = ctx.query.get("conversationId")
    if (conversationId) requireMember(conversationId, userId)
    const rows = store.listMessagesForSearch(userId, { before, limit, conversationId })
    sendJson(ctx.res, 200, { messages: rows.map(toEnvelope), nextBefore: rows.length === limit ? rows[rows.length - 1].id : null })
  })

  // --- web push -----------------------------------------------------------------------
  router.get("/api/push/vapid", (ctx) => {
    sendJson(ctx.res, 200, { publicKey: webpush.publicKey() })
  })
  router.post("/api/me/push/webpush", async (ctx) => {
    const userId = requireAuth(ctx)
    rateLimit("push-webpush:" + userId, 30, 3600000)
    const b = await readJson(ctx.req)
    const endpoint = String(b.endpoint ?? "").trim()
    if (!isAcceptableEndpoint(endpoint)) throw new HttpError(400, "invalid push endpoint")
    const p256dh = b64Field(b.p256dh, "p256dh", 200)
    const auth = b64Field(b.auth, "auth", 100)
    const now = new Date().toISOString()
    store.saveWebPushSubscription({ endpoint, userId, p256dh, auth, deviceId: cleanDeviceId(b.deviceId) || null, createdAt: now, lastSeenAt: now })
    sendJson(ctx.res, 200, { ok: true })
  })
  router.post("/api/me/push/webpush/delete", async (ctx) => {
    const userId = requireAuth(ctx)
    const b = await readJson(ctx.req)
    const endpoint = String(b.endpoint ?? "").trim()
    if (endpoint) store.deleteWebPushSubscription(endpoint, userId)
    sendJson(ctx.res, 200, { ok: true })
  })

  // Other origins (a second domain, a bare IP) come from ALLOWED_ORIGINS.
  const allowedOrigins = new Set([
    "https://frontierx.zkito.fun",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ])
  for (const value of String(process.env.ALLOWED_ORIGINS || "").split(",")) {
    const trimmed = value.trim()
    if (trimmed) allowedOrigins.add(trimmed)
  }
  const isAllowedOrigin = (origin: string): boolean => allowedOrigins.has(origin)
  const rateBuckets = new Map<string, number[]>()
  // The longest window any caller uses; older stamps can never count again.
  const RATE_MAX_WINDOW_MS = 3600000
  const RATE_MAX_KEYS = 20000
  // Wiping the whole table when it fills up would let anyone reset every
  // lockout (including password guessing) by generating enough keys. Instead
  // expired buckets go first, then the least recently created ones.
  const pruneRateBuckets = (now: number): void => {
    if (rateBuckets.size <= RATE_MAX_KEYS) return
    for (const [key, stamps] of rateBuckets) {
      if (stamps.length === 0 || now - stamps[stamps.length - 1] > RATE_MAX_WINDOW_MS) rateBuckets.delete(key)
    }
    for (const key of rateBuckets.keys()) {
      if (rateBuckets.size <= RATE_MAX_KEYS) break
      rateBuckets.delete(key)
    }
  }
  const rateLimit = (key: string, limit: number, windowMs: number): void => {
    const now = Date.now()
    const hits = (rateBuckets.get(key) || []).filter((stamp: number) => now - stamp < windowMs)
    if (hits.length >= limit) throw new HttpError(429, "too many attempts")
    hits.push(now)
    rateBuckets.set(key, hits)
    pruneRateBuckets(now)
  }
  // Login needs different bookkeeping than the endpoints above: rateGuard only
  // inspects the bucket, rateHit records a failed attempt, rateClear wipes it
  // after a success. A real user who mistypes once is never locked out, while a
  // script guessing passwords runs out of attempts quickly.
  const rateGuard = (key: string, limit: number, windowMs: number): void => {
    const now = Date.now()
    const hits = (rateBuckets.get(key) || []).filter((stamp: number) => now - stamp < windowMs)
    rateBuckets.set(key, hits)
    if (hits.length < limit) return
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000))
    throw new HttpError(429, "too many attempts, retry in " + String(retryAfter) + " seconds")
  }
  const rateHit = (key: string, windowMs: number): void => {
    const now = Date.now()
    const hits = (rateBuckets.get(key) || []).filter((stamp: number) => now - stamp < windowMs)
    hits.push(now)
    rateBuckets.set(key, hits)
    pruneRateBuckets(now)
  }
  const rateClear = (key: string): void => {
    rateBuckets.delete(key)
  }
  const peerIsLocal = (ctx: any): boolean => {
    const peer = String(ctx.req.socket.remoteAddress || "")
    return peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1"
  }
  // One IPv6 subscriber usually owns a whole /64, so per-address limits would
  // hand them billions of fresh buckets; limits apply per /64 instead.
  const rateKeyForIp = (ip: string): string => {
    if (ip.startsWith("::ffff:")) return ip.slice(7)
    if (!ip.includes(":")) return ip
    const [head, tail = ""] = ip.split("::")
    const left = head ? head.split(":") : []
    const right = tail ? tail.split(":") : []
    const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left
    return groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64"
  }
  const clientIp = (ctx: any): string => {
    const fwd = peerIsLocal(ctx) ? String(ctx.req.headers["x-forwarded-for"] || "").split(",").slice(-1)[0].trim() : ""
    return rateKeyForIp(fwd || ctx.req.socket.remoteAddress || "unknown")
  }
  const isImageDataUrl = (value: string): boolean => {
    if (!value.startsWith("data:image/")) return false
    if (value.startsWith("data:image/svg")) return false
    return value.indexOf(";base64,") > 0
  }
  registerKeyRoutes({
    router,
    store,
    bus,
    requireAuth,
    requireSession,
    requireMember,
    rateLimit,
    rateGuard,
    rateHit,
    rateClear,
    notifyBots,
  })
  registerBotRoutes(
    {
      router,
      store,
      bus,
      requireAuth,
      rateLimit,
      toEnvelope,
      deliverMessage,
      publishMessageUpdated,
      publishMessageDeleted,
      purgeAccount,
      isImageDataUrl,
      createFileAsset: createFileAssetFor,
      storeFileBlob,
    },
    botHub,
  )

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const ctx: Ctx = {
      req,
      res,
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      params: {},
    }
    const reqOrigin = req.headers.origin
    if (reqOrigin && isAllowedOrigin(reqOrigin)) res.setHeader("access-control-allow-origin", reqOrigin)
    res.setHeader("vary", "origin")
    res.setHeader("x-content-type-options", "nosniff")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader("x-frame-options", "SAMEORIGIN")
    res.setHeader("access-control-allow-headers", "authorization, content-type")
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
    if (ctx.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    Promise.resolve()
      .then(async () => {
        const matched = router.match(ctx.method, ctx.path)
        if (!matched) throw new HttpError(404, "not found")
        ctx.params = matched.params
        await matched.handler(ctx)
      })
      .catch((err) => {
        if (res.headersSent) return
        if (err instanceof KeyChangedError) sendJson(res, 409, { error: err.message, currentKeyId: err.currentKeyId, rekeyNeeded: err.rekeyNeeded })
        else if (err instanceof HttpError) sendJson(res, err.status, { error: err.message })
        else if (err instanceof LifecycleError) sendJson(res, 409, { error: err.message })
        else {
          console.error("[api] unhandled error", err)
          sendJson(res, 500, { error: "internal error" })
        }
      })
  }

  return { listener, store, bus, lifecycle, refreshLastSeen, deliverDueScheduled, bots: botHub }
}
