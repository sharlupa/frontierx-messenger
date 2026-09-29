import { newId } from "@frontierx/shared"
import type { WsEvent } from "@frontierx/protocol"
import { verifyPassword } from "@frontierx/crypto"
import { readJson, sendJson, type Ctx, type Router } from "./http.js"
import { HttpError } from "./errors.js"
import type { EventBus } from "./eventbus.js"
import type { KeyShareRow, KeySlotKind, KeySlotRow, MemberRow, SessionRow, Store, VaultItemRow } from "./store.js"

// Key system v2.
//
// Every account owns one random account key (AK) that never leaves its devices
// in the clear. The server keeps:
//   - slots: the AK sealed with the password, with a recovery key, or for the
//     account's identity key, so any device that knows one of them unlocks it;
//   - the vault: the account's identity keys and every conversation key the
//     account has ever held, each sealed with the AK;
//   - conversation key epochs: a conversation can have many keys over time.
//     Messages name the key they were sealed with, so switching to a new key
//     never makes older messages unreadable, and members hand every key they
//     hold to members that still lack it.
// All of it is ciphertext. The server enforces who may write what, never
// replaces a working copy, and refuses anything that would fork an account's
// keys.

export interface KeyRouteDeps {
  router: Router
  store: Store
  bus: EventBus
  requireAuth: (ctx: Ctx) => string
  requireSession: (ctx: Ctx) => SessionRow
  requireMember: (conversationId: string, userId: string) => MemberRow
  rateLimit: (key: string, limit: number, windowMs: number) => void
  rateGuard: (key: string, limit: number, windowMs: number) => void
  rateHit: (key: string, windowMs: number) => void
  rateClear: (key: string) => void
  notifyBots: (conversationId: string, update: Record<string, unknown>) => void
}

const B64 = /^[A-Za-z0-9+/=_-]+$/
const KEY_ID = /^k_[A-Za-z0-9_-]{8,48}$/
const FINGERPRINT = /^[a-f0-9]{16,64}$/
const SLOT_KINDS: KeySlotKind[] = ["password", "recovery", "identity"]
const LINK_TTL_MS = 10 * 60 * 1000

export function b64Field(value: unknown, name: string, max: number, required = true): string {
  const text = value === undefined || value === null ? "" : String(value)
  if (!text) {
    if (required) throw new HttpError(400, name + " is required")
    return ""
  }
  if (text.length > max || !B64.test(text)) throw new HttpError(400, name + " is invalid")
  return text
}

export function isKeyId(value: unknown): value is string {
  return typeof value === "string" && (value === "legacy" || KEY_ID.test(value))
}

function kdfField(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "kdf is invalid")
  const text = JSON.stringify(value)
  if (text.length > 2000) throw new HttpError(400, "kdf is too large")
  const alg = String((value as Record<string, unknown>).alg ?? "")
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(alg)) throw new HttpError(400, "kdf algorithm is invalid")
  const iterations = (value as Record<string, unknown>).iterations
  if (iterations !== undefined && !(Number.isInteger(iterations) && Number(iterations) >= 100000 && Number(iterations) <= 10000000)) {
    throw new HttpError(400, "kdf iterations out of range")
  }
  return text
}

export function slotFromBody(userId: string, raw: unknown, now: string): KeySlotRow {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "slot is invalid")
  const body = raw as Record<string, unknown>
  const kind = String(body.kind ?? "") as KeySlotKind
  if (!SLOT_KINDS.includes(kind)) throw new HttpError(400, "slot kind must be password, recovery or identity")
  const label = body.label === undefined || body.label === null ? null : String(body.label)
  if (label !== null && (label.length > 120 || (kind === "identity" && !FINGERPRINT.test(label)))) throw new HttpError(400, "slot label is invalid")
  if (kind === "identity" && !label) throw new HttpError(400, "an identity slot names its key fingerprint")
  return {
    id: newId("kslot"),
    userId,
    kind,
    kdf: kdfField(body.kdf),
    iv: b64Field(body.iv, "slot iv", 64),
    ciphertext: b64Field(body.ciphertext, "slot ciphertext", 4096),
    label,
    stale: false,
    createdAt: now,
    updatedAt: now,
  }
}

function publicSlot(slot: KeySlotRow) {
  let kdf: unknown = null
  try {
    kdf = JSON.parse(slot.kdf)
  } catch {
    kdf = null
  }
  return { id: slot.id, kind: slot.kind, kdf, iv: slot.iv, ciphertext: slot.ciphertext, label: slot.label, stale: slot.stale, createdAt: slot.createdAt, updatedAt: slot.updatedAt }
}

function checkField(raw: unknown): { iv: string; ciphertext: string } {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "check is required")
  const body = raw as Record<string, unknown>
  return { iv: b64Field(body.iv, "check iv", 64), ciphertext: b64Field(body.ciphertext, "check ciphertext", 512) }
}

export function publicKeyField(value: unknown, required = true): string {
  return b64Field(value, "publicKey", 2000, required)
}

// Validates the account-key bundle a client uploads when it creates (or
// replaces) the account key: the check value, its first slots and vault items.
export function parseAccountBundle(store: Store, userId: string, raw: unknown, now: string): { check: { iv: string; ciphertext: string }; slots: KeySlotRow[]; vault: VaultItemRow[] } {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "keys are invalid")
  const body = raw as Record<string, unknown>
  const check = checkField(body.check)
  const rawSlots = Array.isArray(body.slots) ? body.slots : []
  if (rawSlots.length === 0 || rawSlots.length > 6) throw new HttpError(400, "an account key needs one to six slots")
  const slots = rawSlots.map((slot) => slotFromBody(userId, slot, now))
  if (slots.filter((slot) => slot.kind === "password").length > 1 || slots.filter((slot) => slot.kind === "recovery").length > 1) {
    throw new HttpError(400, "only one password and one recovery slot are allowed")
  }
  const rawVault = Array.isArray(body.vault) ? body.vault : []
  if (rawVault.length > 64) throw new HttpError(400, "too many vault items")
  const vault = rawVault.map((item) => vaultItemFromBody(store, userId, item, now, false))
  return { check, slots, vault }
}

function vaultItemFromBody(store: Store, userId: string, raw: unknown, now: string, allowCek = true): VaultItemRow {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "vault item is invalid")
  const body = raw as Record<string, unknown>
  const scope = String(body.scope ?? "")
  const iv = b64Field(body.iv, "vault iv", 64)
  const ciphertext = b64Field(body.ciphertext, "vault ciphertext", 8192)
  if (scope === "identity") {
    const itemId = String(body.itemId ?? "")
    if (!FINGERPRINT.test(itemId)) throw new HttpError(400, "identity items are named by their fingerprint")
    return { userId, scope: "identity", itemId, conversationId: null, keyId: null, iv, ciphertext, createdAt: now }
  }
  if (scope === "cek" && allowCek) {
    const conversationId = String(body.conversationId ?? "")
    const keyId = String(body.keyId ?? "")
    if (!conversationId || conversationId.length > 80 || !isKeyId(keyId)) throw new HttpError(400, "vault item names an invalid key")
    if (!store.getMember(conversationId, userId)) throw new HttpError(403, "not a member of this conversation")
    if (!store.getKeyEpoch(conversationId, keyId)) throw new HttpError(404, "no such conversation key")
    return { userId, scope: "cek", itemId: conversationId + ":" + keyId, conversationId, keyId, iv, ciphertext, createdAt: now }
  }
  throw new HttpError(400, "vault scope must be identity or cek")
}

// Validates wrapped copies of a conversation key addressed to members. Every
// copy has to be wrapped for the member's current identity key; a copy for an
// outdated key could never be opened and would only block a working one.
export function parseShares(store: Store, conversationId: string, createdBy: string, raw: unknown, now: string, keyIdOverride?: string): KeyShareRow[] {
  const list = Array.isArray(raw) ? raw : []
  if (list.length > 1000) throw new HttpError(400, "too many key copies")
  const out: KeyShareRow[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const body = item as Record<string, unknown>
    const keyId = keyIdOverride ?? String(body.keyId ?? "")
    if (!isKeyId(keyId)) throw new HttpError(400, "keyId is invalid")
    const memberId = String(body.memberId ?? "")
    if (!memberId || seen.has(keyId + "|" + memberId)) continue
    const member = store.getMember(conversationId, memberId)
    if (!member) throw new HttpError(400, "key copies can only be addressed to members")
    const user = store.getUserById(memberId)
    const recipientKey = publicKeyField(body.recipientKey)
    if (!user || !user.publicKey || user.publicKey !== recipientKey) throw new HttpError(409, "the member's identity key has changed; reload the member list")
    seen.add(keyId + "|" + memberId)
    out.push({
      conversationId,
      keyId,
      memberId,
      ephemeralPublicKey: b64Field(body.ephemeralPublicKey, "ephemeralPublicKey", 400),
      iv: b64Field(body.iv, "share iv", 64),
      ciphertext: b64Field(body.ciphertext, "share ciphertext", 512),
      recipientKey,
      createdBy,
      createdAt: now,
    })
  }
  return out
}

export function registerKeyRoutes(deps: KeyRouteDeps): void {
  const { router, store, bus } = deps

  const membersOf = (conversationId: string): string[] => store.listMembers(conversationId).map((m) => m.userId)

  // Everyone in a chat is told that some members still lack keys, so whoever
  // holds them hands them over, even on a device that was idle until now.
  const announceSharesNeeded = (conversationId: string, exceptUserId?: string): void => {
    const targets = membersOf(conversationId).filter((id) => id !== exceptUserId)
    bus.publishToUsers(targets, { type: "keys.shares_needed", conversationId } as unknown as WsEvent)
  }
  const announceToAllChats = (userId: string): void => {
    for (const conversationId of store.listConversationIdsForUser(userId)) announceSharesNeeded(conversationId, userId)
  }

  const keyState = (userId: string) => {
    const account = store.getAccountKey(userId)
    const user = store.getUserById(userId)
    const backup = store.getKeyBackup(userId)
    return {
      accountKey: account ? { check: { iv: account.checkIv, ciphertext: account.checkCiphertext }, createdAt: account.createdAt } : null,
      slots: store.listKeySlots(userId).map(publicSlot),
      publicKey: user?.publicKey ?? null,
      legacyBackup: backup ? { salt: backup.salt, iv: backup.iv, ciphertext: backup.ciphertext, iterations: backup.iterations, publicKey: backup.publicKey } : null,
      identities: store.listVaultItems(userId, { scope: "identity" }).map((item) => ({ itemId: item.itemId, iv: item.iv, ciphertext: item.ciphertext })),
      vaultCount: store.countVaultItems(userId),
      passwordChangedAt: userPasswordChangedAt(store, userId),
    }
  }

  router.get("/api/keys/state", (ctx) => {
    const userId = deps.requireAuth(ctx)
    sendJson(ctx.res, 200, keyState(userId))
  })

  // First account key: exactly once per account. A second device that finds
  // one must unlock it instead of creating its own.
  router.post("/api/keys/account", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    deps.rateLimit("keys-account:" + userId, 10, 3600000)
    const body = await readJson(ctx.req)
    const now = new Date().toISOString()
    const bundle = parseAccountBundle(store, userId, body, now)
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    if (bundle.slots.some((slot) => slot.kind === "password")) requirePassword(userId, body.password)
    const publicKey = body.publicKey === undefined || body.publicKey === null ? null : publicKeyField(body.publicKey)
    const created = store.createAccountKey({
      userId,
      checkIv: bundle.check.iv,
      checkCiphertext: bundle.check.ciphertext,
      slots: bundle.slots,
      vault: bundle.vault,
      publicKey,
      now,
    })
    if (!created) throw new HttpError(409, "this account already has an account key")
    if (publicKey && publicKey !== user.publicKey) {
      store.deleteStaleSharesForMember(userId, publicKey)
      announceToAllChats(userId)
    }
    sendJson(ctx.res, 201, keyState(userId))
  })

  // Starting over when every way back is lost. It needs the password again, so
  // a stolen session cannot wipe someone's keys. Chats with other people come
  // back as soon as another member's device hands the keys over.
  router.post("/api/keys/reset", async (ctx) => {
    const session = deps.requireSession(ctx)
    const userId = session.userId
    const nameKey = "login-name:" + (store.getUserById(userId)?.username ?? userId).toLowerCase()
    deps.rateGuard(nameKey, 8, 900000)
    const body = await readJson(ctx.req)
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    if (!verifyPassword(String(body.password ?? ""), user.passwordHash)) {
      deps.rateHit(nameKey, 900000)
      throw new HttpError(401, "invalid credentials")
    }
    deps.rateClear(nameKey)
    const now = new Date().toISOString()
    const publicKey = publicKeyField(body.publicKey)
    const bundle = parseAccountBundle(store, userId, body, now)
    store.resetAccountKeys({ userId, checkIv: bundle.check.iv, checkCiphertext: bundle.check.ciphertext, slots: bundle.slots, vault: bundle.vault, publicKey, now })
    bus.publishToUsers([userId], { type: "keys.account_reset", sessionId: session.id } as unknown as WsEvent)
    announceToAllChats(userId)
    sendJson(ctx.res, 200, keyState(userId))
  })

  // A password slot is only accepted together with the account password, so a
  // buggy or hostile client cannot seal the keys under something else and lock
  // the owner out of their next sign-in.
  const requirePassword = (userId: string, password: unknown): void => {
    const user = store.getUserById(userId)
    if (!user) throw new HttpError(404, "user not found")
    const nameKey = "login-name:" + user.username.toLowerCase()
    deps.rateGuard(nameKey, 8, 900000)
    if (!verifyPassword(String(password ?? ""), user.passwordHash)) {
      deps.rateHit(nameKey, 900000)
      throw new HttpError(401, "invalid credentials")
    }
    deps.rateClear(nameKey)
  }

  router.post("/api/keys/slots", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    deps.rateLimit("keys-slot:" + userId, 30, 3600000)
    if (!store.getAccountKey(userId)) throw new HttpError(409, "create the account key first")
    const body = await readJson(ctx.req)
    const slot = slotFromBody(userId, body, new Date().toISOString())
    if (slot.kind === "password") requirePassword(userId, body.password)
    store.putKeySlot(slot)
    sendJson(ctx.res, 201, { slot: publicSlot(slot), slots: store.listKeySlots(userId).map(publicSlot) })
  })

  // Replacing a lost identity key (the account key is fine but the identity it
  // should hold is gone). Members hand the chat keys to the new identity, so it
  // takes the password like starting over does.
  router.post("/api/keys/identity", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    deps.rateLimit("keys-identity:" + userId, 10, 3600000)
    if (!store.getAccountKey(userId)) throw new HttpError(409, "create the account key first")
    const body = await readJson(ctx.req)
    requirePassword(userId, body.password)
    const publicKey = publicKeyField(body.publicKey)
    const now = new Date().toISOString()
    const item = vaultItemFromBody(store, userId, body.identity, now, false)
    const slot = slotFromBody(userId, body.slot, now)
    if (slot.kind !== "identity") throw new HttpError(400, "an identity slot is required")
    store.putVaultItems([item])
    store.putKeySlot(slot)
    store.setUserPublicKey(userId, publicKey)
    store.deleteStaleSharesForMember(userId, publicKey)
    announceToAllChats(userId)
    sendJson(ctx.res, 200, keyState(userId))
  })

  router.post("/api/keys/slots/:id/delete", (ctx) => {
    const userId = deps.requireAuth(ctx)
    const slot = store.getKeySlot(ctx.params.id)
    if (!slot || slot.userId !== userId) throw new HttpError(404, "slot not found")
    // The last way to unlock the keys is never removed by accident.
    const remaining = store.listKeySlots(userId).filter((item) => item.id !== slot.id && !item.stale)
    if (remaining.length === 0) throw new HttpError(409, "this is the last way to unlock your keys")
    store.deleteKeySlot(userId, slot.id)
    sendJson(ctx.res, 200, { slots: store.listKeySlots(userId).map(publicSlot) })
  })

  router.get("/api/keys/vault", (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.query.get("conversationId")
    const scope = ctx.query.get("scope")
    const items = conversationId
      ? store.listVaultItems(userId, { conversationId })
      : store.listVaultItems(userId, scope === "identity" || scope === "cek" ? { scope } : {})
    sendJson(ctx.res, 200, {
      items: items.map((item) => ({ scope: item.scope, itemId: item.itemId, conversationId: item.conversationId, keyId: item.keyId, iv: item.iv, ciphertext: item.ciphertext })),
    })
  })

  router.post("/api/keys/vault", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    deps.rateLimit("keys-vault:" + userId, 600, 3600000)
    if (!store.getAccountKey(userId)) throw new HttpError(409, "create the account key first")
    const body = await readJson(ctx.req)
    const list = Array.isArray(body.items) ? body.items : []
    if (list.length > 500) throw new HttpError(400, "too many vault items")
    const now = new Date().toISOString()
    const items = list.map((item: unknown) => vaultItemFromBody(store, userId, item, now))
    const added = store.putVaultItems(items)
    sendJson(ctx.res, 200, { added })
  })

  // Every copy addressed to this account, for devices that move them into the
  // vault once, so they survive any later change of the identity key.
  router.get("/api/keys/shares", (ctx) => {
    const userId = deps.requireAuth(ctx)
    const shares = store.listKeySharesForMember(userId).map((share) => ({
      conversationId: share.conversationId,
      keyId: share.keyId,
      ephemeralPublicKey: share.ephemeralPublicKey,
      iv: share.iv,
      ciphertext: share.ciphertext,
      recipientKey: share.recipientKey,
    }))
    sendJson(ctx.res, 200, { shares })
  })

  router.get("/api/keys/pending", (ctx) => {
    const userId = deps.requireAuth(ctx)
    sendJson(ctx.res, 200, { missing: store.listMissingShares(userId) })
  })

  // --- per conversation ---------------------------------------------------

  router.get("/api/conversations/:id/keys", (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.params.id
    deps.requireMember(conversationId, userId)
    const state = store.getConversationKeyState(conversationId)
    sendJson(ctx.res, 200, {
      currentKeyId: state.currentKeyId,
      rekeyNeeded: state.rekeyNeeded,
      epochs: store.listKeyEpochs(conversationId).map((epoch) => ({ keyId: epoch.keyId, createdBy: epoch.createdBy, createdAt: epoch.createdAt, check: epoch.keyCheck })),
      shares: store.listKeySharesForMember(userId, conversationId).map((share) => ({
        keyId: share.keyId,
        ephemeralPublicKey: share.ephemeralPublicKey,
        iv: share.iv,
        ciphertext: share.ciphertext,
        recipientKey: share.recipientKey,
      })),
      vault: store.listVaultItems(userId, { conversationId }).map((item) => ({ keyId: item.keyId, iv: item.iv, ciphertext: item.ciphertext })),
      missing: store.listMissingShares(userId, conversationId, 1000),
    })
  })

  // A new key for the conversation, with copies for its members, becomes the
  // current key only if nobody else switched it in the meantime.
  router.post("/api/conversations/:id/keys/epochs", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.params.id
    const member = deps.requireMember(conversationId, userId)
    if (member.role === "restricted") throw new HttpError(403, "your role is read-only")
    deps.rateLimit("keys-epoch:" + conversationId, 30, 3600000)
    const body = await readJson(ctx.req)
    const keyId = String(body.keyId ?? "")
    if (!KEY_ID.test(keyId)) throw new HttpError(400, "keyId is invalid")
    const expected = body.expectedCurrentKeyId === null || body.expectedCurrentKeyId === undefined ? null : String(body.expectedCurrentKeyId)
    const keyCheck = b64Field(body.check, "check", 512)
    const now = new Date().toISOString()
    const shares = parseShares(store, conversationId, userId, body.shares, now, keyId)
    if (!shares.some((share) => share.memberId === userId)) throw new HttpError(400, "the creator keeps a copy of the new key")
    const result = store.createKeyEpoch({ conversationId, keyId, expectedCurrentKeyId: expected, createdBy: userId, createdAt: now, keyCheck, shares })
    if (!result.ok) {
      sendJson(ctx.res, 409, { error: "the conversation key changed meanwhile", currentKeyId: result.currentKeyId })
      return
    }
    bus.publishToUsers(membersOf(conversationId), { type: "keys.epoch_created", conversationId, keyId, createdBy: userId } as unknown as WsEvent)
    deps.notifyBots(conversationId, { type: "keys_updated", conversationId })
    if (shares.length < store.listMembers(conversationId).length) announceSharesNeeded(conversationId, userId)
    sendJson(ctx.res, 201, { currentKeyId: keyId })
  })

  router.post("/api/conversations/:id/keys/shares", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.params.id
    deps.requireMember(conversationId, userId)
    deps.rateLimit("keys-share:" + userId, 2000, 3600000)
    const body = await readJson(ctx.req)
    const now = new Date().toISOString()
    const shares = parseShares(store, conversationId, userId, body.shares, now)
    // Only someone who can read a key may hand it over.
    for (const share of shares) {
      if (!store.getKeyEpoch(conversationId, share.keyId)) throw new HttpError(404, "no such conversation key")
      if (!store.userHoldsKey(userId, conversationId, share.keyId)) throw new HttpError(403, "you do not hold this key")
    }
    const added = store.putKeyShares(shares)
    const recipients = Array.from(new Set(added.map((share) => share.memberId)))
    for (const recipient of recipients) {
      const keyIds = added.filter((share) => share.memberId === recipient).map((share) => share.keyId)
      bus.publishToUsers([recipient], { type: "keys.shares_added", conversationId, keyIds } as unknown as WsEvent)
    }
    const botRecipients = recipients.filter((id) => store.isBot(id))
    if (botRecipients.length > 0) deps.notifyBots(conversationId, { type: "keys_updated", conversationId })
    sendJson(ctx.res, 200, { added: added.length })
  })

  // The copy addressed to me does not open (it was wrapped for a key I lost):
  // drop it so another member sends a fresh one.
  router.post("/api/conversations/:id/keys/reject", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.params.id
    deps.requireMember(conversationId, userId)
    const body = await readJson(ctx.req)
    const keyId = String(body.keyId ?? "")
    if (!isKeyId(keyId)) throw new HttpError(400, "keyId is invalid")
    // The last readable copy anywhere (a chat with oneself, or everybody else
    // left) is kept: another of this account's devices may still open it.
    if (!store.otherHolderExists(conversationId, keyId, userId)) {
      sendJson(ctx.res, 409, { error: "this is the only copy of the key", removed: false })
      return
    }
    const removed = store.deleteKeyShare(conversationId, keyId, userId)
    if (removed) announceSharesNeeded(conversationId, userId)
    sendJson(ctx.res, 200, { removed })
  })

  router.post("/api/conversations/:id/keys/request", (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.params.id
    deps.requireMember(conversationId, userId)
    deps.rateLimit("keys-request:" + userId + ":" + conversationId, 6, 600000)
    announceSharesNeeded(conversationId, userId)
    sendJson(ctx.res, 200, { ok: true })
  })

  // --- linking a new device -------------------------------------------------
  // The new device shows a code derived from its one-time key; a device that
  // already holds the account key compares it and sends the key sealed for
  // that one-time key only. The server relays ciphertext and never sees it.

  router.post("/api/keys/link", async (ctx) => {
    const session = deps.requireSession(ctx)
    deps.rateLimit("keys-link:" + session.userId, 12, 3600000)
    const body = await readJson(ctx.req)
    const ephemeralPublicKey = b64Field(body.ephemeralPublicKey, "ephemeralPublicKey", 400)
    const label = String(body.label ?? session.label ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "New device"
    const now = new Date()
    const pending = store.listPendingLinkRequests(session.userId, now.toISOString())
    for (const old of pending.filter((request) => request.sessionId === session.id)) store.deleteLinkRequest(old.id)
    if (pending.filter((request) => request.sessionId !== session.id).length >= 5) throw new HttpError(429, "too many pending device requests")
    const request = {
      id: newId("klink"),
      userId: session.userId,
      sessionId: session.id,
      ephemeralPublicKey,
      label,
      status: "pending" as const,
      response: null,
      approvedBySession: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LINK_TTL_MS).toISOString(),
    }
    store.createLinkRequest(request)
    bus.publishToUsers([session.userId], { type: "keys.link_requested", request: { id: request.id, label, createdAt: request.createdAt, expiresAt: request.expiresAt, ephemeralPublicKey } } as unknown as WsEvent)
    sendJson(ctx.res, 201, { id: request.id, expiresAt: request.expiresAt })
  })

  router.get("/api/keys/link/pending", (ctx) => {
    const session = deps.requireSession(ctx)
    const requests = store
      .listPendingLinkRequests(session.userId, new Date().toISOString())
      .filter((request) => request.sessionId !== session.id)
      .map((request) => ({ id: request.id, label: request.label, createdAt: request.createdAt, expiresAt: request.expiresAt, ephemeralPublicKey: request.ephemeralPublicKey }))
    sendJson(ctx.res, 200, { requests })
  })

  router.get("/api/keys/link/:id", (ctx) => {
    const session = deps.requireSession(ctx)
    const request = store.getLinkRequest(ctx.params.id)
    if (!request || request.userId !== session.userId || request.sessionId !== session.id) throw new HttpError(404, "request not found")
    if (Date.parse(request.expiresAt) <= Date.now() && request.status === "pending") {
      store.deleteLinkRequest(request.id)
      throw new HttpError(410, "request expired")
    }
    let response: unknown = null
    if (request.status === "approved" && request.response) {
      try {
        response = JSON.parse(request.response)
      } catch {
        response = null
      }
      // Handed over once, then gone.
      store.deleteLinkRequest(request.id)
    }
    if (request.status === "denied") store.deleteLinkRequest(request.id)
    sendJson(ctx.res, 200, { status: request.status, response })
  })

  const resolveLink = async (ctx: Ctx, status: "approved" | "denied") => {
    const session = deps.requireSession(ctx)
    const request = store.getLinkRequest(ctx.params.id)
    if (!request || request.userId !== session.userId) throw new HttpError(404, "request not found")
    if (request.sessionId === session.id) throw new HttpError(403, "a device cannot approve itself")
    if (request.status !== "pending" || Date.parse(request.expiresAt) <= Date.now()) throw new HttpError(410, "request expired")
    let response: string | null = null
    if (status === "approved") {
      const body = await readJson(ctx.req)
      response = JSON.stringify({
        ephemeralPublicKey: b64Field(body.ephemeralPublicKey, "ephemeralPublicKey", 400),
        iv: b64Field(body.iv, "iv", 64),
        ciphertext: b64Field(body.ciphertext, "ciphertext", 1024),
      })
    }
    if (!store.resolveLinkRequest(request.id, status, response, session.id)) throw new HttpError(409, "request already resolved")
    bus.publishToUsers([session.userId], { type: "keys.link_resolved", id: request.id, status } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  }
  router.post("/api/keys/link/:id/approve", (ctx) => resolveLink(ctx, "approved"))
  router.post("/api/keys/link/:id/deny", (ctx) => resolveLink(ctx, "denied"))
}

// New messages must be sealed with the conversation's current key. After a
// member left (re-key pending) or somebody switched keys, a device with a stale
// view is told so and re-seals with the right key; this keeps people who left
// from reading anything sent after they left. Unencrypted payloads (tests,
// tools) pass unchecked.
export function sealedKeyId(ciphertext: string): string | null {
  if (ciphertext.startsWith("fx1:")) return "legacy"
  if (ciphertext.startsWith("fx2:")) {
    const end = ciphertext.indexOf(":", 4)
    return end > 4 ? ciphertext.slice(4, end) : ""
  }
  return null
}

export function assertCurrentKey(store: Store, conversationId: string, ciphertext: string): void {
  const keyId = sealedKeyId(ciphertext)
  if (keyId === null) return
  const state = store.getConversationKeyState(conversationId)
  if (state.rekeyNeeded || !state.currentKeyId || keyId !== state.currentKeyId) {
    throw new KeyChangedError(state.currentKeyId, state.rekeyNeeded)
  }
}

export class KeyChangedError extends HttpError {
  constructor(readonly currentKeyId: string | null, readonly rekeyNeeded: boolean) {
    super(409, "conversation key changed")
    this.name = "KeyChangedError"
  }
}

export function userPasswordChangedAt(store: Store, userId: string): string | null {
  return store.getPasswordChangedAt(userId)
}
