import { createHash, randomBytes } from "node:crypto"
import { newId } from "@frontierx/shared"
import type { MessageEnvelope, WsEvent } from "@frontierx/protocol"
import { readJson, sendBytes, sendJson, type Ctx, type Router } from "./http.js"
import { HttpError } from "./errors.js"
import type { EventBus } from "./eventbus.js"
import type { BotRow, ConversationRow, MemberRow, MessageRow, Store, UserRow } from "./store.js"
import { assertPublicUrl, guardedRequest } from "./netguard.js"
import { assertCurrentKey, b64Field, isKeyId, parseShares, publicKeyField } from "./keysv2.js"
import { deleteBlob, readBlob } from "./blobstore.js"

// Bots and the Bot API.
//
// A bot is an account without a password that its owner controls through a
// token. The token is shown once and only its hash is stored. It opens the Bot
// API under /api/bot/v1 and nothing else: every user route authenticates
// sessions, which bots never have, and the login route refuses bot accounts.
//
// Chats with bots stay end-to-end encrypted. A bot holds its own identity key
// (the SDK in packages/bot-sdk creates and keeps it), receives wrapped copies
// of the conversation keys like any member, and sends ciphertext. The server
// never sees what is said to a bot.

const BOT_USERNAME = /^[A-Za-z0-9_]{3,32}$/
const MAX_BOTS_PER_OWNER = 20
const LONG_POLL_MAX_MS = 50000
const WEBHOOK_TIMEOUT_MS = 10000
const WEBHOOK_MAX_FAILURES = 20

export function hashBotToken(token: string): string {
  return createHash("sha256").update("frontierx:bot:" + token).digest("hex")
}

function newBotToken(): string {
  return "fxb_" + randomBytes(32).toString("base64url")
}

export interface BotCommand {
  command: string
  description: string
}

function parseCommands(raw: unknown): BotCommand[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "commands must be a list")
  if (raw.length > 50) throw new HttpError(400, "at most 50 commands")
  const out: BotCommand[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new HttpError(400, "command is invalid")
    const command = String((item as Record<string, unknown>).command ?? "").replace(/^\//, "").trim().toLowerCase()
    const description = String((item as Record<string, unknown>).description ?? "").replace(/\s+/g, " ").trim()
    if (!/^[a-z0-9_]{1,32}$/.test(command)) throw new HttpError(400, "command names use a-z, 0-9 and _ (up to 32)")
    if (description.length > 120) throw new HttpError(400, "command descriptions are up to 120 characters")
    if (seen.has(command)) continue
    seen.add(command)
    out.push({ command, description })
  }
  return out
}

export function readBotCommands(bot: BotRow | null): BotCommand[] {
  if (!bot) return []
  try {
    const parsed = JSON.parse(bot.commands)
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.command === "string").map((item) => ({ command: String(item.command), description: String(item.description ?? "") })) : []
  } catch {
    return []
  }
}

export interface BotRouteDeps {
  router: Router
  store: Store
  bus: EventBus
  requireAuth: (ctx: Ctx) => string
  rateLimit: (key: string, limit: number, windowMs: number) => void
  toEnvelope: (message: MessageRow) => MessageEnvelope
  deliverMessage: (message: MessageRow) => void
  publishMessageUpdated: (message: MessageRow) => void
  publishMessageDeleted: (conversationId: string, messageId: string) => void
  purgeAccount: (userId: string) => number
  isImageDataUrl: (value: string) => boolean
  createFileAsset: (userId: string, body: Record<string, unknown>) => { asset: { id: string; conversationId: string; size: number } }
  storeFileBlob: (userId: string, fileId: string, req: Ctx["req"]) => Promise<number>
}

// Queues updates per bot and hands them out by long polling or webhook.
export class BotHub {
  private waiters = new Map<string, Set<() => void>>()
  private webhookChains = new Map<string, Promise<void>>()

  constructor(private readonly store: Store) {}

  // Records an update for every bot in the conversation (except the one that
  // caused it) and wakes whoever is waiting for it.
  notifyConversation(conversationId: string, update: Record<string, unknown>, exceptBotId?: string): void {
    let botIds: string[]
    try {
      botIds = this.store.listBotMemberIds(conversationId)
    } catch {
      return
    }
    for (const botId of botIds) {
      if (botId === exceptBotId) continue
      this.notifyBot(botId, update)
    }
  }

  notifyBot(botId: string, update: Record<string, unknown>): void {
    try {
      this.store.addBotUpdate(botId, JSON.stringify(update), new Date().toISOString())
    } catch {
      return
    }
    const set = this.waiters.get(botId)
    if (set) {
      for (const wake of Array.from(set)) wake()
    }
    const bot = this.store.getBot(botId)
    if (bot && bot.webhookUrl) this.scheduleWebhook(botId)
  }

  wait(botId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(botId)
      if (!set) {
        set = new Set()
        this.waiters.set(botId, set)
      }
      const done = () => {
        clearTimeout(timer)
        set?.delete(done)
        if (set && set.size === 0) this.waiters.delete(botId)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      set.add(done)
    })
  }

  // Webhook deliveries of one bot run one after another, so updates arrive in
  // order; a failing endpoint is retried on the next update and switched off
  // after many failures in a row (updates then wait for getUpdates).
  scheduleWebhook(botId: string): void {
    const previous = this.webhookChains.get(botId) ?? Promise.resolve()
    const next = previous.then(() => this.flushWebhook(botId)).catch(() => undefined)
    this.webhookChains.set(botId, next)
    void next.then(() => {
      if (this.webhookChains.get(botId) === next) this.webhookChains.delete(botId)
    })
  }

  private async flushWebhook(botId: string): Promise<void> {
    for (let round = 0; round < 20; round++) {
      const bot = this.store.getBot(botId)
      if (!bot || !bot.webhookUrl) return
      const pending = this.store.listBotUpdates(botId, 0, 20)
      if (pending.length === 0) return
      for (const item of pending) {
        let ok = false
        try {
          const body = JSON.stringify({ updateId: item.id, ...JSON.parse(item.payload) })
          const response = await guardedRequest(assertPublicUrl(bot.webhookUrl, { httpsOnly: true }), {
            method: "POST",
            headers: { "content-type": "application/json", "x-frontierx-bot-secret": bot.webhookSecret ?? "" },
            body,
            timeoutMs: WEBHOOK_TIMEOUT_MS,
            maxBytes: 16 * 1024,
            truncate: true,
          })
          ok = response.status >= 200 && response.status < 300
        } catch {
          ok = false
        }
        if (!ok) {
          const failures = bot.webhookFailures + 1
          this.store.updateBot(botId, failures >= WEBHOOK_MAX_FAILURES ? { webhookFailures: 0, webhookUrl: null, webhookSecret: null } : { webhookFailures: failures })
          return
        }
        this.store.ackBotUpdates(botId, item.id + 1)
        if (bot.webhookFailures > 0) this.store.updateBot(botId, { webhookFailures: 0 })
      }
    }
  }
}

// Deleting a bot takes its chats with it: a chat with the bot alone disappears
// for the person in it (files included). Returns the groups and channels the
// bot was in, to be told once the account itself is gone.
export function dropBotDirectChats(store: Store, bus: EventBus, botId: string): Array<{ conversationId: string; members: string[] }> {
  const groups: Array<{ conversationId: string; members: string[] }> = []
  for (const conversationId of store.listConversationIdsForUser(botId)) {
    const conversation = store.getConversation(conversationId)
    const members = store.listMembers(conversationId).map((m) => m.userId).filter((id) => id !== botId)
    if (!conversation || conversation.kind !== "direct") {
      groups.push({ conversationId, members })
      continue
    }
    const assetIds = store.listFileAssetsByConversation(conversationId).map((asset) => asset.id)
    store.deleteConversation(conversationId)
    for (const assetId of assetIds) {
      try {
        deleteBlob(assetId)
      } catch {
        // the file was already gone
      }
    }
    bus.publishToUsers(members, { type: "conversation.deleted", conversationId } as unknown as WsEvent)
  }
  return groups
}

// Groups the bot left move to a key it never had.
export function announceBotRemoved(store: Store, bus: EventBus, botId: string, groups: Array<{ conversationId: string; members: string[] }>): void {
  for (const { conversationId, members } of groups) {
    if (!store.getConversation(conversationId)) continue
    store.markRekeyNeeded(conversationId)
    bus.publishToUsers(members, { type: "member.removed", conversationId, userId: botId } as unknown as WsEvent)
  }
}

export function registerBotRoutes(deps: BotRouteDeps, hub: BotHub): void {
  const { router, store, bus } = deps

  const botInfo = (bot: BotRow, user: UserRow | null) => ({
    id: bot.id,
    username: user?.username ?? "",
    displayName: user?.displayName ?? "",
    avatar: user?.avatar ?? null,
    description: bot.description,
    allowGroups: bot.allowGroups,
    commands: readBotCommands(bot),
    webhook: bot.webhookUrl ? { url: bot.webhookUrl, failures: bot.webhookFailures } : null,
    hasIdentityKey: Boolean(user?.publicKey),
    createdAt: bot.createdAt,
    tokenCreatedAt: bot.tokenCreatedAt,
    lastUsedAt: bot.lastUsedAt,
  })

  const ownedBot = (ctx: Ctx): { ownerId: string; bot: BotRow; user: UserRow } => {
    const ownerId = deps.requireAuth(ctx)
    const bot = store.getBot(ctx.params.id)
    if (!bot || bot.ownerId !== ownerId) throw new HttpError(404, "bot not found")
    const user = store.getUserById(bot.id)
    if (!user) throw new HttpError(404, "bot not found")
    return { ownerId, bot, user }
  }

  // --- management by the owner ---------------------------------------------

  router.get("/api/bots", (ctx) => {
    const ownerId = deps.requireAuth(ctx)
    const bots = store.listBotsForOwner(ownerId).map((bot) => botInfo(bot, store.getUserById(bot.id)))
    sendJson(ctx.res, 200, { bots })
  })

  router.post("/api/bots", async (ctx) => {
    const ownerId = deps.requireAuth(ctx)
    if (store.isBot(ownerId)) throw new HttpError(403, "bots cannot create bots")
    deps.rateLimit("bot-create:" + ownerId, 10, 3600000)
    const body = await readJson(ctx.req)
    const username = String(body.username ?? "").trim()
    if (!BOT_USERNAME.test(username) || !username.toLowerCase().endsWith("bot")) {
      throw new HttpError(400, "a bot username has 3-32 letters, digits or _ and ends with bot")
    }
    if (store.getUserByUsername(username)) throw new HttpError(409, "username is taken")
    if (store.countBotsForOwner(ownerId) >= MAX_BOTS_PER_OWNER) throw new HttpError(409, "you already have the maximum number of bots")
    const displayName = String(body.displayName ?? "").replace(/\s+/g, " ").trim().slice(0, 64) || username
    const description = body.description ? String(body.description).trim().slice(0, 512) : null
    const token = newBotToken()
    const now = new Date().toISOString()
    const user: UserRow = { id: newId("user"), username, passwordHash: "!bot", displayName, createdAt: now, publicKey: null, avatar: null, isBot: true, botOwnerId: ownerId }
    store.createBot({ user, ownerId, tokenHash: hashBotToken(token), description, now })
    const bot = store.getBot(user.id) as BotRow
    sendJson(ctx.res, 201, { bot: botInfo(bot, store.getUserById(user.id)), token })
  })

  router.post("/api/bots/:id/update", async (ctx) => {
    const { bot } = ownedBot(ctx)
    const body = await readJson(ctx.req)
    if (body.displayName !== undefined) {
      const displayName = String(body.displayName ?? "").replace(/\s+/g, " ").trim()
      if (!displayName || displayName.length > 64) throw new HttpError(400, "displayName must contain 1-64 characters")
      store.updateUserDisplayName(bot.id, displayName)
    }
    store.updateBot(bot.id, {
      description: body.description === undefined ? undefined : body.description === null ? null : String(body.description).trim().slice(0, 512),
      allowGroups: body.allowGroups === undefined ? undefined : Boolean(body.allowGroups),
      commands: body.commands === undefined ? undefined : JSON.stringify(parseCommands(body.commands)),
    })
    const next = store.getBot(bot.id) as BotRow
    sendJson(ctx.res, 200, { bot: botInfo(next, store.getUserById(bot.id)) })
  })

  router.post("/api/bots/:id/avatar", async (ctx) => {
    const { bot } = ownedBot(ctx)
    const body = await readJson(ctx.req)
    const avatar = body.avatar === null || body.avatar === undefined || body.avatar === "" ? null : String(body.avatar)
    if (avatar && avatar.length > 700000) throw new HttpError(413, "avatar image is too large")
    if (avatar && !deps.isImageDataUrl(avatar)) throw new HttpError(400, "avatar must be an image data url")
    store.setUserAvatar(bot.id, avatar)
    sendJson(ctx.res, 200, { bot: botInfo(store.getBot(bot.id) as BotRow, store.getUserById(bot.id)) })
  })

  // A new token invalidates the old one immediately.
  router.post("/api/bots/:id/token", (ctx) => {
    const { bot } = ownedBot(ctx)
    deps.rateLimit("bot-token:" + bot.id, 10, 3600000)
    const token = newBotToken()
    store.updateBot(bot.id, { tokenHash: hashBotToken(token), tokenCreatedAt: new Date().toISOString() })
    sendJson(ctx.res, 200, { token })
  })

  router.post("/api/bots/:id/delete", (ctx) => {
    const { bot } = ownedBot(ctx)
    const groups = dropBotDirectChats(store, bus, bot.id)
    deps.purgeAccount(bot.id)
    announceBotRemoved(store, bus, bot.id, groups)
    sendJson(ctx.res, 200, { ok: true })
  })

  // What a person chatting with a bot may know about it: its description and
  // commands, offered in the composer. Only for bots you share a chat with.
  router.get("/api/bots/profile/:userId", (ctx) => {
    const userId = deps.requireAuth(ctx)
    const bot = store.getBot(ctx.params.userId)
    const user = bot ? store.getUserById(bot.id) : null
    if (!bot || !user) throw new HttpError(404, "bot not found")
    const shared = store.listConversationIdsForUser(bot.id).some((conversationId) => Boolean(store.getMember(conversationId, userId)))
    if (!shared && bot.ownerId !== userId) throw new HttpError(404, "bot not found")
    sendJson(ctx.res, 200, { id: bot.id, username: user.username, displayName: user.displayName, description: bot.description, commands: readBotCommands(bot) })
  })

  // --- buttons under bot messages ---------------------------------------------
  // A press is relayed to the bot as a "callback" update. What the button
  // carries arrives sealed with the chat key; the server only checks that the
  // person is in the chat and that the message came from a bot that still is.
  // The bot may answer once (a short notice shown to that person).
  const callbacks = new Map<string, { botId: string; userId: string; conversationId: string; at: number }>()
  const CALLBACK_TTL_MS = 10 * 60 * 1000

  router.post("/api/conversations/:id/messages/:messageId/callback", async (ctx) => {
    const userId = deps.requireAuth(ctx)
    const conversationId = ctx.params.id
    if (!store.getMember(conversationId, userId)) throw new HttpError(404, "conversation not found")
    const message = store.getMessage(ctx.params.messageId)
    if (!message || message.conversationId !== conversationId || message.deletedAt) throw new HttpError(404, "message not found")
    const bot = store.getUserById(message.senderId)
    if (!bot || !bot.isBot || !store.getMember(conversationId, bot.id)) throw new HttpError(409, "this message has no buttons")
    deps.rateLimit("bot-callback:" + userId, 30, 60000)
    const body = await readJson(ctx.req)
    const data = String(body.data ?? "")
    if (!data || data.length > 4096) throw new HttpError(400, "data must contain 1-4096 characters")
    const now = Date.now()
    for (const [id, entry] of callbacks) if (now - entry.at > CALLBACK_TTL_MS) callbacks.delete(id)
    if (callbacks.size > 20000) callbacks.clear()
    const callbackId = newId("cb")
    callbacks.set(callbackId, { botId: bot.id, userId, conversationId, at: now })
    const user = store.getUserById(userId)
    hub.notifyBot(bot.id, {
      type: "callback",
      callbackId,
      conversationId,
      messageId: message.id,
      from: { id: userId, username: user?.username ?? null, displayName: user?.displayName ?? null, isBot: false },
      data,
    })
    sendJson(ctx.res, 200, { callbackId })
  })

  // --- the Bot API -------------------------------------------------------------

  const lastTouch = new Map<string, number>()
  const requireBot = (ctx: Ctx): { bot: BotRow; user: UserRow } => {
    const header = String(ctx.req.headers.authorization ?? "")
    const match = /^(?:Bot|Bearer)\s+(fxb_[A-Za-z0-9_-]{20,80})$/.exec(header.trim())
    if (!match) throw new HttpError(401, "missing bot token")
    const bot = store.getBotByTokenHash(hashBotToken(match[1]))
    if (!bot) throw new HttpError(401, "invalid bot token")
    const user = store.getUserById(bot.id)
    if (!user || !user.isBot) throw new HttpError(401, "invalid bot token")
    const now = Date.now()
    if ((lastTouch.get(bot.id) ?? 0) + 60000 < now) {
      lastTouch.set(bot.id, now)
      store.updateBot(bot.id, { lastUsedAt: new Date(now).toISOString() })
    }
    deps.rateLimit("bot-api:" + bot.id, 120, 1000)
    return { bot, user }
  }

  const botMember = (botId: string, conversationId: string): { member: MemberRow; conversation: ConversationRow } => {
    const conversation = store.getConversation(conversationId)
    const member = conversation ? store.getMember(conversationId, botId) : null
    if (!conversation || !member) throw new HttpError(403, "the bot is not a member of this conversation")
    return { member, conversation }
  }

  const conversationId = (value: unknown): string => {
    const id = String(value ?? "")
    if (!id || id.length > 80) throw new HttpError(400, "conversationId is required")
    return id
  }

  const memberView = (conversationIdValue: string) =>
    store.listMembers(conversationIdValue).map((m) => {
      const u = store.getUserById(m.userId)
      return { userId: m.userId, role: m.role, username: u?.username ?? null, displayName: u?.displayName ?? null, publicKey: u?.publicKey ?? null, isBot: Boolean(u?.isBot) }
    })

  const conversationView = (conversation: ConversationRow) => ({ id: conversation.id, kind: conversation.kind, title: conversation.title, createdAt: conversation.createdAt })

  const botRoute = (method: "GET" | "POST", name: string, handler: (ctx: Ctx, bot: BotRow, user: UserRow) => void | Promise<void>) => {
    router.add(method, "/api/bot/v1/" + name, async (ctx) => {
      const { bot, user } = requireBot(ctx)
      await handler(ctx, bot, user)
    })
  }

  botRoute("GET", "getMe", (ctx, bot, user) => {
    sendJson(ctx.res, 200, { ok: true, result: { id: bot.id, username: user.username, displayName: user.displayName, publicKey: user.publicKey, allowGroups: bot.allowGroups, commands: readBotCommands(bot) } })
  })

  // The bot publishes the public half of its own identity key. Copies wrapped
  // for an earlier key are dropped and the members hand the keys over again.
  botRoute("POST", "setIdentityKey", async (ctx, bot, user) => {
    const body = await readJson(ctx.req)
    const publicKey = publicKeyField(body.publicKey)
    if (publicKey !== user.publicKey) {
      deps.rateLimit("bot-key:" + bot.id, 10, 3600000)
      store.setUserPublicKey(bot.id, publicKey)
      store.deleteStaleSharesForMember(bot.id, publicKey)
      for (const id of store.listConversationIdsForUser(bot.id)) {
        store.deleteKeyShare(id, "legacy", bot.id)
        const members = store.listMembers(id).map((m) => m.userId).filter((memberId) => memberId !== bot.id)
        bus.publishToUsers(members, { type: "keys.shares_needed", conversationId: id } as unknown as WsEvent)
      }
    }
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("GET", "getUpdates", async (ctx, bot) => {
    if (bot.webhookUrl) throw new HttpError(409, "a webhook is set; delete it to use getUpdates")
    const offset = Math.max(0, Math.floor(Number(ctx.query.get("offset") ?? 0)) || 0)
    const limit = Math.max(1, Math.min(100, Math.floor(Number(ctx.query.get("limit") ?? 100)) || 100))
    const timeout = Math.max(0, Math.min(LONG_POLL_MAX_MS, Math.floor(Number(ctx.query.get("timeout") ?? 0) * 1000) || 0))
    if (offset > 0) store.ackBotUpdates(bot.id, offset)
    let updates = store.listBotUpdates(bot.id, offset, limit)
    if (updates.length === 0 && timeout > 0) {
      let closed = false
      ctx.req.on("close", () => {
        closed = true
      })
      await hub.wait(bot.id, timeout)
      if (closed) return
      updates = store.listBotUpdates(bot.id, offset, limit)
    }
    sendJson(ctx.res, 200, {
      ok: true,
      result: updates.map((item) => {
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(item.payload)
        } catch {
          payload = {}
        }
        return { updateId: item.id, createdAt: item.createdAt, ...payload }
      }),
    })
  })

  botRoute("POST", "setWebhook", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const url = String(body.url ?? "").trim()
    if (url.length > 500) throw new HttpError(400, "webhook url is too long")
    try {
      assertPublicUrl(url, { httpsOnly: true })
    } catch {
      throw new HttpError(400, "the webhook must be a public https address")
    }
    const secret = body.secret === undefined || body.secret === null ? "" : String(body.secret)
    if (secret && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new HttpError(400, "the secret uses A-Z, a-z, 0-9, _ and - (up to 256)")
    store.updateBot(bot.id, { webhookUrl: url, webhookSecret: secret || null, webhookFailures: 0 })
    hub.scheduleWebhook(bot.id)
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("POST", "deleteWebhook", (ctx, bot) => {
    store.updateBot(bot.id, { webhookUrl: null, webhookSecret: null, webhookFailures: 0 })
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("GET", "getWebhookInfo", (ctx, bot) => {
    sendJson(ctx.res, 200, { ok: true, result: { url: bot.webhookUrl, failures: bot.webhookFailures, pending: store.listBotUpdates(bot.id, 0, 1000).length } })
  })

  botRoute("POST", "setCommands", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    store.updateBot(bot.id, { commands: JSON.stringify(parseCommands(body.commands)) })
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("GET", "getConversations", (ctx, bot) => {
    const result = store.listConversationsForUser(bot.id).map((conversation) => conversationView(conversation))
    sendJson(ctx.res, 200, { ok: true, result })
  })

  botRoute("GET", "getConversation", (ctx, bot) => {
    const id = conversationId(ctx.query.get("conversationId"))
    const { conversation } = botMember(bot.id, id)
    sendJson(ctx.res, 200, { ok: true, result: { conversation: conversationView(conversation), members: memberView(id) } })
  })

  botRoute("GET", "getMessages", (ctx, bot) => {
    const id = conversationId(ctx.query.get("conversationId"))
    botMember(bot.id, id)
    const limit = Math.max(1, Math.min(100, Math.floor(Number(ctx.query.get("limit") ?? 50)) || 50))
    const before = ctx.query.get("before")
    sendJson(ctx.res, 200, { ok: true, result: store.listMessages(id, { limit, before }).map(deps.toEnvelope) })
  })

  const requireBotCanSend = (botId: string, id: string): ConversationRow => {
    const { member, conversation } = botMember(botId, id)
    if (member.role === "restricted") throw new HttpError(403, "the bot is read-only in this conversation")
    if (conversation.kind === "channel" && member.role !== "owner" && member.role !== "admin") throw new HttpError(403, "only channel administrators can post")
    return conversation
  }

  botRoute("POST", "sendMessage", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    const conversation = requireBotCanSend(bot.id, id)
    deps.rateLimit("bot-send:" + bot.id, 30, 1000)
    deps.rateLimit("bot-send:" + bot.id + ":" + id, conversation.kind === "direct" ? 60 : 20, 60000)
    const ciphertext = String(body.ciphertext ?? "")
    if (!ciphertext || ciphertext.length > 262144) throw new HttpError(400, "ciphertext must contain 1-262144 characters")
    assertCurrentKey(store, id, ciphertext)
    const replyTo = body.replyTo ? String(body.replyTo) : null
    if (replyTo && store.getMessage(replyTo)?.conversationId !== id) throw new HttpError(404, "message not found")
    const message: MessageRow = { id: newId("msg"), conversationId: id, senderId: bot.id, ciphertext, replyTo, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null, silent: body.silent === true }
    deps.deliverMessage(message)
    sendJson(ctx.res, 200, { ok: true, result: deps.toEnvelope(message) })
  })

  botRoute("POST", "editMessage", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    botMember(bot.id, id)
    const existing = store.getMessage(String(body.messageId ?? ""))
    if (!existing || existing.conversationId !== id || existing.senderId !== bot.id) throw new HttpError(404, "message not found")
    if (existing.deletedAt) throw new HttpError(409, "message is deleted")
    const ciphertext = String(body.ciphertext ?? "")
    if (!ciphertext || ciphertext.length > 262144) throw new HttpError(400, "ciphertext must contain 1-262144 characters")
    assertCurrentKey(store, id, ciphertext)
    store.editMessage(existing.id, ciphertext, new Date().toISOString())
    const updated = store.getMessage(existing.id) as MessageRow
    deps.publishMessageUpdated(updated)
    sendJson(ctx.res, 200, { ok: true, result: deps.toEnvelope(updated) })
  })

  botRoute("POST", "deleteMessage", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    botMember(bot.id, id)
    const existing = store.getMessage(String(body.messageId ?? ""))
    if (!existing || existing.conversationId !== id || existing.senderId !== bot.id) throw new HttpError(404, "message not found")
    store.softDeleteMessage(existing.id, new Date().toISOString())
    deps.publishMessageDeleted(id, existing.id)
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("POST", "sendTyping", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    requireBotCanSend(bot.id, id)
    deps.rateLimit("bot-typing:" + bot.id + ":" + id, 12, 60000)
    const others = store.listMembers(id).map((m) => m.userId).filter((userId) => userId !== bot.id)
    bus.publishToUsers(others, { type: "typing", conversationId: id, userId: bot.id } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("POST", "leaveConversation", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    const { conversation } = botMember(bot.id, id)
    const members = store.listMembers(id).map((m) => m.userId)
    if (conversation.kind === "direct") {
      store.deleteConversation(id)
      bus.publishToUsers(members, { type: "conversation.deleted", conversationId: id } as unknown as WsEvent)
    } else {
      store.removeMember(id, bot.id)
      store.markRekeyNeeded(id)
      bus.publishToUsers(members, { type: "member.removed", conversationId: id, userId: bot.id } as unknown as WsEvent)
    }
    sendJson(ctx.res, 200, { ok: true })
  })

  botRoute("GET", "getKeys", (ctx, bot) => {
    const id = conversationId(ctx.query.get("conversationId"))
    botMember(bot.id, id)
    const state = store.getConversationKeyState(id)
    sendJson(ctx.res, 200, {
      ok: true,
      result: {
        currentKeyId: state.currentKeyId,
        rekeyNeeded: state.rekeyNeeded,
        epochs: store.listKeyEpochs(id).map((epoch) => ({ keyId: epoch.keyId, createdBy: epoch.createdBy, createdAt: epoch.createdAt, check: epoch.keyCheck })),
        shares: store.listKeySharesForMember(bot.id, id).map((share) => ({ keyId: share.keyId, ephemeralPublicKey: share.ephemeralPublicKey, iv: share.iv, ciphertext: share.ciphertext, recipientKey: share.recipientKey })),
        missing: store.listMissingShares(bot.id, id, 1000),
        members: memberView(id),
      },
    })
  })

  botRoute("POST", "createKeyEpoch", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    requireBotCanSend(bot.id, id)
    deps.rateLimit("keys-epoch:" + id, 30, 3600000)
    const keyId = String(body.keyId ?? "")
    if (!isKeyId(keyId) || keyId === "legacy") throw new HttpError(400, "keyId is invalid")
    const expected = body.expectedCurrentKeyId === null || body.expectedCurrentKeyId === undefined ? null : String(body.expectedCurrentKeyId)
    const now = new Date().toISOString()
    const shares = parseShares(store, id, bot.id, body.shares, now, keyId)
    if (!shares.some((share) => share.memberId === bot.id)) throw new HttpError(400, "the creator keeps a copy of the new key")
    const result = store.createKeyEpoch({ conversationId: id, keyId, expectedCurrentKeyId: expected, createdBy: bot.id, createdAt: now, keyCheck: b64Field(body.check, "check", 512), shares })
    if (!result.ok) {
      sendJson(ctx.res, 409, { ok: false, error: "the conversation key changed meanwhile", currentKeyId: result.currentKeyId })
      return
    }
    const members = store.listMembers(id).map((m) => m.userId)
    bus.publishToUsers(members, { type: "keys.epoch_created", conversationId: id, keyId, createdBy: bot.id } as unknown as WsEvent)
    hub.notifyConversation(id, { type: "keys_updated", conversationId: id }, bot.id)
    sendJson(ctx.res, 200, { ok: true, result: { currentKeyId: keyId } })
  })

  botRoute("POST", "shareKeys", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    botMember(bot.id, id)
    const shares = parseShares(store, id, bot.id, body.shares, new Date().toISOString())
    for (const share of shares) {
      if (!store.getKeyEpoch(id, share.keyId)) throw new HttpError(404, "no such conversation key")
      if (!store.userHoldsKey(bot.id, id, share.keyId)) throw new HttpError(403, "the bot does not hold this key")
    }
    const added = store.putKeyShares(shares)
    for (const share of added) bus.publishToUsers([share.memberId], { type: "keys.shares_added", conversationId: id, keyIds: [share.keyId] } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true, result: { added: added.length } })
  })

  botRoute("POST", "rejectKey", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    botMember(bot.id, id)
    const keyId = String(body.keyId ?? "")
    if (!isKeyId(keyId)) throw new HttpError(400, "keyId is invalid")
    if (!store.otherHolderExists(id, keyId, bot.id)) throw new HttpError(409, "this is the only copy of the key")
    if (store.deleteKeyShare(id, keyId, bot.id)) {
      const members = store.listMembers(id).map((m) => m.userId).filter((userId) => userId !== bot.id)
      bus.publishToUsers(members, { type: "keys.shares_needed", conversationId: id } as unknown as WsEvent)
    }
    sendJson(ctx.res, 200, { ok: true })
  })

  // Answers a button press: an optional short notice (sealed like a message)
  // shown to the person who pressed it, as a toast or, with alert, a dialog.
  botRoute("POST", "answerCallback", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const callbackId = String(body.callbackId ?? "")
    const entry = callbacks.get(callbackId)
    if (!entry || entry.botId !== bot.id || Date.now() - entry.at > CALLBACK_TTL_MS) throw new HttpError(404, "callback not found or already answered")
    callbacks.delete(callbackId)
    const text = body.text === undefined || body.text === null ? null : String(body.text)
    if (text !== null && text.length > 4096) throw new HttpError(400, "text is too long")
    bus.publishToUsers([entry.userId], { type: "bot.callback_answer", callbackId, conversationId: entry.conversationId, botId: bot.id, text, alert: body.alert === true } as unknown as WsEvent)
    sendJson(ctx.res, 200, { ok: true })
  })

  // Sending an attachment, the same way the apps do: the SDK encrypts the
  // file, registers it here (name and type sealed with the chat key), uploads
  // the ciphertext with uploadFile and then sends a message that carries the
  // file key. The server never sees the file, its name or its type.
  botRoute("POST", "createFile", async (ctx, bot) => {
    const body = await readJson(ctx.req)
    const id = conversationId(body.conversationId)
    requireBotCanSend(bot.id, id)
    deps.rateLimit("bot-file:" + bot.id, 120, 3600000)
    const name = String(body.name ?? "")
    const mime = String(body.mime ?? "")
    if (!name || name.length > 2048 || !mime || mime.length > 2048) throw new HttpError(400, "name and mime must be sealed with the conversation key")
    const created = deps.createFileAsset(bot.id, { conversationId: id, name, mime, size: body.size })
    sendJson(ctx.res, 201, { ok: true, result: { fileId: created.asset.id } })
  })

  botRoute("POST", "uploadFile", async (ctx, bot) => {
    const fileId = String(ctx.query.get("fileId") ?? "")
    const asset = fileId ? store.getFileAsset(fileId) : null
    if (!asset || asset.ownerId !== bot.id) {
      ctx.req.resume()
      throw new HttpError(404, "file not found")
    }
    requireBotCanSend(bot.id, asset.conversationId)
    const bytes = await deps.storeFileBlob(bot.id, asset.id, ctx.req)
    sendJson(ctx.res, 200, { ok: true, result: { fileId: asset.id, bytes } })
  })

  // Attachments are encrypted end to end like everything else; the bot gets
  // the ciphertext and decrypts it with the key from the message envelope.
  botRoute("GET", "downloadFile", (ctx, bot) => {
    const fileId = String(ctx.query.get("fileId") ?? "")
    const asset = fileId ? store.getFileAsset(fileId) : null
    if (!asset) throw new HttpError(404, "file not found")
    botMember(bot.id, asset.conversationId)
    const bytes = readBlob(asset.id)
    if (!bytes) throw new HttpError(404, "file not found")
    sendBytes(ctx.res, 200, bytes)
  })
}
