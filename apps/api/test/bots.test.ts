import { test } from "node:test"
import assert from "node:assert/strict"
import { api, registerUser, startTestServer } from "./helpers"

async function botApi(base: string, method: string, token: string, opts: { query?: string; body?: unknown } = {}) {
  const res = await fetch(base + "/api/bot/v1/" + method + (opts.query ? "?" + opts.query : ""), {
    method: opts.body === undefined ? "GET" : "POST",
    headers: { authorization: "Bot " + token, ...(opts.body === undefined ? {} : { "content-type": "application/json" }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

test("bots: creation rules, one-time token, owner-only management", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "botowner")
  const other = await registerUser(s.base, "notowner")
  assert.equal((await api(s.base, "/api/bots", { token: owner.token, body: { username: "helper", displayName: "Helper" } })).status, 400)
  assert.equal((await api(s.base, "/api/bots", { token: owner.token, body: { username: "bad name bot" } })).status, 400)
  const created = await api(s.base, "/api/bots", { token: owner.token, body: { username: "helper_bot", displayName: "Helper", description: "Says hi" } })
  assert.equal(created.status, 201)
  const token = created.json.token as string
  assert.match(token, /^fxb_[A-Za-z0-9_-]{40,}$/)
  const botId = created.json.bot.id as string
  assert.equal((await api(s.base, "/api/bots", { token: owner.token, body: { username: "helper_bot" } })).status, 409)

  // The token is never shown again and only its hash is stored.
  const list = await api(s.base, "/api/bots", { token: owner.token })
  assert.equal(list.json.bots.length, 1)
  assert.equal(JSON.stringify(list.json).includes(token), false)
  assert.equal(JSON.stringify(s.app.store.getBot(botId)).includes(token), false)

  // Somebody else cannot see, change, rotate or delete it.
  assert.equal((await api(s.base, "/api/bots", { token: other.token })).json.bots.length, 0)
  assert.equal((await api(s.base, `/api/bots/${botId}/update`, { token: other.token, body: { displayName: "Owned" } })).status, 404)
  assert.equal((await api(s.base, `/api/bots/${botId}/token`, { token: other.token, body: {} })).status, 404)
  assert.equal((await api(s.base, `/api/bots/${botId}/delete`, { token: other.token, body: {} })).status, 404)

  // Rotating the token kills the old one at once.
  assert.equal((await botApi(s.base, "getMe", token)).status, 200)
  const rotated = await api(s.base, `/api/bots/${botId}/token`, { token: owner.token, body: {} })
  assert.equal((await botApi(s.base, "getMe", token)).status, 401)
  assert.equal((await botApi(s.base, "getMe", rotated.json.token)).json.result.username, "helper_bot")

  const updated = await api(s.base, `/api/bots/${botId}/update`, { token: owner.token, body: { commands: [{ command: "/start", description: "Begin" }, { command: "help", description: "Help" }], allowGroups: false } })
  assert.equal(updated.status, 200)
  assert.deepEqual(updated.json.bot.commands.map((c: { command: string }) => c.command), ["start", "help"])
  assert.equal(updated.json.bot.allowGroups, false)
  assert.equal((await api(s.base, `/api/bots/${botId}/update`, { token: owner.token, body: { commands: [{ command: "no spaces", description: "x" }] } })).status, 400)
})

test("bot tokens open the Bot API and nothing else; bots cannot sign in", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner2")
  const created = await api(s.base, "/api/bots", { token: owner.token, body: { username: "guard_bot" } })
  const token = created.json.token as string
  // User routes take sessions, never bot tokens.
  for (const path of ["/api/me", "/api/conversations", "/api/keys/state", "/api/users/search?q=owner"]) {
    const res = await fetch(s.base + path, { headers: { authorization: "Bearer " + token } })
    assert.equal(res.status, 401, path)
  }
  assert.equal((await api(s.base, "/api/auth/login", { body: { username: "guard_bot", password: "!bot" } })).status, 401)
  assert.equal((await botApi(s.base, "getMe", "fxb_" + "x".repeat(43))).status, 401)
  assert.equal((await fetch(s.base + "/api/bot/v1/getMe")).status, 401)
  // A user session is no bot token either.
  const res = await fetch(s.base + "/api/bot/v1/getMe", { headers: { authorization: "Bearer " + owner.token } })
  assert.equal(res.status, 401)
})

test("starting a bot opens a chat; the bot receives and answers messages", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner3")
  const user = await registerUser(s.base, "chatter")
  const created = await api(s.base, "/api/bots", { token: owner.token, body: { username: "echo_bot" } })
  const token = created.json.token as string
  assert.equal((await botApi(s.base, "setIdentityKey", token, { body: { publicKey: Buffer.from("bot-pub").toString("base64") } })).status, 200)

  const started = await api(s.base, "/api/friends/requests", { token: user.token, body: { username: "echo_bot" } })
  assert.equal(started.status, 200)
  assert.equal(started.json.status, "accepted")
  assert.equal(started.json.conversation.peer.isBot, true)
  const cid = started.json.conversation.id as string
  // Starting again returns the same chat.
  assert.equal((await api(s.base, "/api/friends/requests", { token: user.token, body: { username: "echo_bot" } })).json.conversation.id, cid)

  const first = await botApi(s.base, "getUpdates", token)
  assert.equal(first.json.result[0].type, "conversation_added")
  assert.equal(first.json.result[0].conversation.id, cid)

  const sent = await api(s.base, `/api/conversations/${cid}/messages`, { token: user.token, body: { ciphertext: "opaque-payload" } })
  assert.equal(sent.status, 201)
  const next = await botApi(s.base, "getUpdates", token, { query: "offset=" + (first.json.result[0].updateId + 1) })
  assert.equal(next.json.result.length, 1)
  assert.equal(next.json.result[0].type, "message")
  assert.equal(next.json.result[0].message.ciphertext, "opaque-payload")
  assert.equal(next.json.result[0].sender.username, "chatter")

  // Long polling wakes up when a message arrives.
  const offset = next.json.result[0].updateId + 1
  const waiting = botApi(s.base, "getUpdates", token, { query: "offset=" + offset + "&timeout=5" })
  await new Promise((resolve) => setTimeout(resolve, 150))
  await api(s.base, `/api/conversations/${cid}/messages`, { token: user.token, body: { ciphertext: "second" } })
  const woke = await waiting
  assert.equal(woke.json.result[0].message.ciphertext, "second")

  const reply = await botApi(s.base, "sendMessage", token, { body: { conversationId: cid, ciphertext: "reply", silent: true } })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.result.silent, true)
  const history = await api(s.base, `/api/conversations/${cid}/messages`, { token: user.token })
  assert.equal(history.json.messages.at(-1).ciphertext, "reply")
  // The bot's own message is not echoed back to it.
  const quiet = await botApi(s.base, "getUpdates", token, { query: "offset=" + (woke.json.result[0].updateId + 1) })
  assert.equal(quiet.json.result.length, 0)

  // The bot only reaches chats it is in.
  const stranger = await registerUser(s.base, "stranger3")
  const group = await api(s.base, "/api/conversations", { token: stranger.token, body: { kind: "group", title: "Closed" } })
  assert.equal((await botApi(s.base, "sendMessage", token, { body: { conversationId: group.json.conversation.id, ciphertext: "x" } })).status, 403)
  assert.equal((await botApi(s.base, "getMessages", token, { query: "conversationId=" + group.json.conversation.id })).status, 403)
  // No calls with a bot.
  assert.equal((await api(s.base, `/api/conversations/${cid}/call/join`, { token: user.token, body: {} })).status, 403)
})

test("bots join groups only when their owner allows it", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner4")
  const created = await api(s.base, "/api/bots", { token: owner.token, body: { username: "group_bot" } })
  await api(s.base, "/api/friends/requests", { token: owner.token, body: { username: "group_bot" } })
  await api(s.base, `/api/bots/${created.json.bot.id}/update`, { token: owner.token, body: { allowGroups: false } })
  const group = await api(s.base, "/api/conversations", { token: owner.token, body: { kind: "group", title: "Team", memberUsernames: ["group_bot"] } })
  assert.equal(group.json.members.length, 1)
  await api(s.base, `/api/bots/${created.json.bot.id}/update`, { token: owner.token, body: { allowGroups: true } })
  const added = await api(s.base, `/api/conversations/${group.json.conversation.id}/members/add`, { token: owner.token, body: { usernames: ["group_bot"] } })
  assert.equal(added.json.members.length, 2)
  assert.equal(added.json.members.find((m: { username: string }) => m.username === "group_bot").isBot, true)
  const updates = await botApi(s.base, "getUpdates", created.json.token)
  assert.ok(updates.json.result.some((u: { type: string; conversation?: { id: string } }) => u.type === "conversation_added" && u.conversation?.id === group.json.conversation.id))
})

test("webhooks must be public https addresses", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner5")
  const token = (await api(s.base, "/api/bots", { token: owner.token, body: { username: "hook_bot" } })).json.token as string
  for (const url of ["http://example.com/hook", "https://127.0.0.1/hook", "https://localhost/hook", "https://10.0.0.1/x", "https://[::1]/x", "file:///etc/passwd", "https://user:pw@example.com/"]) {
    assert.equal((await botApi(s.base, "setWebhook", token, { body: { url } })).status, 400, url)
  }
  assert.equal((await botApi(s.base, "setWebhook", token, { body: { url: "https://example.com/hook", secret: "bad secret!" } })).status, 400)
})

test("deleting the owner deletes their bots", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner6")
  const created = await api(s.base, "/api/bots", { token: owner.token, body: { username: "gone_bot" } })
  assert.equal((await api(s.base, "/api/me/delete", { token: owner.token, body: { password: "password123" } })).status, 200)
  assert.equal(s.app.store.getBot(created.json.bot.id), null)
  assert.equal(s.app.store.getUserByUsername("gone_bot"), null)
  assert.equal((await botApi(s.base, "getMe", created.json.token)).status, 401)
})

test("a deleted bot's chats disappear instead of turning into empty direct chats", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner7")
  const user = await registerUser(s.base, "chatter7")
  const created = await api(s.base, "/api/bots", { token: owner.token, body: { username: "temp_bot" } })
  const botId = created.json.bot.id as string
  await api(s.base, `/api/bots/${botId}/update`, { token: owner.token, body: { allowGroups: true } })
  const direct = (await api(s.base, "/api/friends/requests", { token: user.token, body: { username: "temp_bot" } })).json.conversation.id as string
  await api(s.base, `/api/conversations/${direct}/messages`, { token: user.token, body: { ciphertext: "hello bot" } })
  await api(s.base, "/api/friends/requests", { token: owner.token, body: { username: "temp_bot" } })
  const group = await api(s.base, "/api/conversations", { token: owner.token, body: { kind: "group", title: "With bot", memberUsernames: ["temp_bot"] } })
  const groupId = group.json.conversation.id as string
  assert.equal(group.json.members.length, 2)

  assert.equal((await api(s.base, `/api/bots/${botId}/delete`, { token: owner.token, body: {} })).status, 200)
  // The person's chat with the bot is gone, not left behind as a nameless chat.
  const list = await api(s.base, "/api/conversations", { token: user.token })
  assert.equal(list.json.conversations.some((c: { id: string }) => c.id === direct), false)
  assert.equal(s.app.store.getConversation(direct), null)
  assert.equal(s.app.store.listMessages(direct, { limit: 10 }).length, 0)
  // The group stays, without the bot, and moves to a new key.
  const members = await api(s.base, `/api/conversations/${groupId}/members`, { token: owner.token })
  assert.deepEqual(members.json.members.map((m: { username: string }) => m.username), ["owner7"])
  assert.equal(s.app.store.getConversationKeyState(groupId).rekeyNeeded, true)
})

test("deleting the owner also removes the chats people had with their bots", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner8")
  const user = await registerUser(s.base, "chatter8")
  await api(s.base, "/api/bots", { token: owner.token, body: { username: "orphan_bot" } })
  const direct = (await api(s.base, "/api/friends/requests", { token: user.token, body: { username: "orphan_bot" } })).json.conversation.id as string
  assert.equal((await api(s.base, "/api/me/delete", { token: owner.token, body: { password: "password123" } })).status, 200)
  const list = await api(s.base, "/api/conversations", { token: user.token })
  assert.equal(list.json.conversations.some((c: { id: string }) => c.id === direct), false)
})

test("bot uploads stay inside the bot's own chats and files", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner9")
  const user = await registerUser(s.base, "chatter9")
  const token = (await api(s.base, "/api/bots", { token: owner.token, body: { username: "upload_bot" } })).json.token as string
  const chat = (await api(s.base, "/api/friends/requests", { token: user.token, body: { username: "upload_bot" } })).json.conversation.id as string
  const upload = (fileId: string, body: string) => fetch(s.base + "/api/bot/v1/uploadFile?fileId=" + encodeURIComponent(fileId), { method: "POST", headers: { authorization: "Bot " + token, "content-type": "application/octet-stream" }, body })

  const created = await botApi(s.base, "createFile", token, { body: { conversationId: chat, name: "sealed-name", mime: "sealed-mime", size: 5 } })
  assert.equal(created.status, 201)
  const fileId = created.json.result.fileId as string
  assert.equal((await upload(fileId, "bytes")).status, 200)
  // The person in the chat can fetch it.
  const fetched = await fetch(s.base + "/api/files/" + fileId + "/blob", { headers: { authorization: "Bearer " + user.token } })
  assert.equal(await fetched.text(), "bytes")

  // Not in chats the bot is not in, not over someone else's file, not as a path.
  const other = await registerUser(s.base, "other9")
  const group = await api(s.base, "/api/conversations", { token: other.token, body: { kind: "group", title: "Private" } })
  assert.equal((await botApi(s.base, "createFile", token, { body: { conversationId: group.json.conversation.id, name: "x", mime: "y", size: 1 } })).status, 403)
  const theirs = await api(s.base, "/api/files", { token: user.token, body: { conversationId: chat, name: "n", mime: "m", size: 1 } })
  assert.equal((await upload(theirs.json.asset.id, "overwrite")).status, 404)
  assert.equal((await upload("../../../etc/passwd", "x")).status, 404)
  assert.equal((await botApi(s.base, "createFile", token, { body: { conversationId: chat, name: "", mime: "y", size: 1 } })).status, 400)
  // The size limit applies to bots too.
  assert.equal((await botApi(s.base, "createFile", token, { body: { conversationId: chat, name: "x", mime: "y", size: 1e15 } })).status, 413)
})

test("button presses reach only the bot that sent the message", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const owner = await registerUser(s.base, "owner10")
  const user = await registerUser(s.base, "chatter10")
  const stranger = await registerUser(s.base, "stranger10")
  const token = (await api(s.base, "/api/bots", { token: owner.token, body: { username: "press_bot" } })).json.token as string
  const otherToken = (await api(s.base, "/api/bots", { token: owner.token, body: { username: "other_bot" } })).json.token as string
  const chat = (await api(s.base, "/api/friends/requests", { token: user.token, body: { username: "press_bot" } })).json.conversation.id as string
  const botMessage = await botApi(s.base, "sendMessage", token, { body: { conversationId: chat, ciphertext: "menu" } })
  const mine = await api(s.base, `/api/conversations/${chat}/messages`, { token: user.token, body: { ciphertext: "hi" } })
  const press = (token_: string, messageId: string, data = "sealed") => api(s.base, `/api/conversations/${chat}/messages/${messageId}/callback`, { token: token_, body: { data } })

  const ok = await press(user.token, botMessage.json.result.id)
  assert.equal(ok.status, 200)
  // Only under a bot's message, only for people in the chat, with data.
  assert.equal((await press(user.token, mine.json.message.id)).status, 409)
  assert.equal((await press(stranger.token, botMessage.json.result.id)).status, 404)
  assert.equal((await press(user.token, botMessage.json.result.id, "")).status, 400)
  // The bot gets the press with who pressed it.
  const updates = await botApi(s.base, "getUpdates", token)
  const callback = updates.json.result.find((u: { type: string }) => u.type === "callback")
  assert.equal(callback.from.username, "chatter10")
  assert.equal(callback.messageId, botMessage.json.result.id)
  // Another bot cannot answer it; the right one answers once.
  assert.equal((await botApi(s.base, "answerCallback", otherToken, { body: { callbackId: ok.json.callbackId } })).status, 404)
  assert.equal((await botApi(s.base, "answerCallback", token, { body: { callbackId: ok.json.callbackId, text: "sealed-answer" } })).status, 200)
  assert.equal((await botApi(s.base, "answerCallback", token, { body: { callbackId: ok.json.callbackId } })).status, 404)
})
