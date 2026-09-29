import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/store"
import { api, directConversation, registerUser, startTestServer } from "./helpers"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// a and b share a direct chat (contacts); c only shares a group with b.
async function setup(base: string, prefix: string) {
  const { a, b, cid } = await directConversation(base, prefix + "a", prefix + "b")
  const c = await registerUser(base, prefix + "c")
  // b and c become friends only to be able to share a group; the direct chat
  // between them is then removed so c is a group co-member, not a contact.
  await api(base, "/api/friends/requests", { token: b.token, body: { username: c.user.username } })
  await api(base, "/api/friends/requests", { token: c.token, body: { username: b.user.username } })
  const group = await api(base, "/api/conversations", { token: b.token, body: { kind: "group", title: "G", memberUsernames: [c.user.username] } })
  await api(base, `/api/friends/${c.user.id}/remove`, { token: b.token, body: {} })
  return { a, b, c, cid, gid: group.json.conversation.id as string }
}

test("the last-seen time follows everyone, contacts, nobody and exceptions", async () => {
  const s = await startTestServer()
  try {
    const { a, b, c, cid, gid } = await setup(s.base, "ls1")
    // b comes online and leaves: the time is recorded at the disconnect.
    const leave = s.app.bus.subscribeUser(b.user.id, () => {})
    const before = Date.now()
    leave()
    const seen = (await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id]
    assert.ok(seen && Date.parse(seen) >= before - 1000, "a sees b's last-seen time")
    assert.ok((await api(s.base, `/api/conversations/${gid}/presence`, { token: c.token })).json.lastSeen[b.user.id], "everyone: a group member sees it too")
    assert.ok((await api(s.base, "/api/presence", { token: a.token })).json.lastSeen[b.user.id], "global snapshot carries it")

    await api(s.base, "/api/me/settings", { token: b.token, body: { seenTimePolicy: "contacts" } })
    assert.ok((await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id], "contacts: a still sees it")
    assert.equal((await api(s.base, `/api/conversations/${gid}/presence`, { token: c.token })).json.lastSeen[b.user.id], undefined, "contacts: c does not")

    await api(s.base, "/api/me/settings", { token: b.token, body: { seenTimePolicy: "nobody" } })
    assert.equal((await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id], undefined, "nobody: hidden from a")

    const allow = await api(s.base, "/api/me/privacy/exceptions", { token: b.token, body: { targetId: a.user.id, scope: "seenTime", mode: "allow" } })
    assert.equal(allow.status, 200)
    assert.ok((await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id], "allow exception wins over nobody")

    await api(s.base, "/api/me/settings", { token: b.token, body: { seenTimePolicy: "everyone" } })
    await api(s.base, "/api/me/privacy/exceptions", { token: b.token, body: { targetId: a.user.id, scope: "seenTime", mode: "deny" } })
    assert.equal((await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id], undefined, "deny exception wins over everyone")
    const settings = (await api(s.base, "/api/me/settings", { token: b.token })).json
    assert.equal(settings.seenTimePolicy, "everyone")
    assert.ok(settings.exceptions.some((e: { scope: string; mode: string }) => e.scope === "seenTime" && e.mode === "deny"))
  } finally {
    await s.close()
  }
})

test("presence events carry the time only for viewers who may see it", async () => {
  const s = await startTestServer()
  try {
    const { a, b, c } = await setup(s.base, "ls2")
    await api(s.base, "/api/me/settings", { token: b.token, body: { seenTimePolicy: "contacts" } })
    const eventsFor = (id: string) => {
      const events: Array<{ type: string; userId?: string; online?: boolean; lastSeenAt?: string | null }> = []
      s.app.bus.subscribeUser(id, (event) => events.push(event as never), { presence: false })
      return events
    }
    const aEvents = eventsFor(a.user.id)
    const cEvents = eventsFor(c.user.id)
    s.app.bus.subscribeUser(b.user.id, () => {})()
    const aOffline = aEvents.filter((e) => e.type === "presence.updated" && e.userId === b.user.id && e.online === false).pop()
    const cOffline = cEvents.filter((e) => e.type === "presence.updated" && e.userId === b.user.id && e.online === false).pop()
    assert.ok(aOffline?.lastSeenAt, "the contact gets the new time with the offline event")
    assert.equal(cOffline?.lastSeenAt, null, "a non-contact gets no time")
  } finally {
    await s.close()
  }
})

test("ghost mode hides the time and records nothing", async () => {
  const s = await startTestServer()
  try {
    const { a, b, cid } = await setup(s.base, "ls3")
    s.app.bus.subscribeUser(b.user.id, () => {})()
    const first = (await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id]
    assert.ok(first)
    await api(s.base, "/api/me/settings", { token: b.token, body: { ghostMode: true } })
    assert.equal((await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id], undefined, "hidden in ghost mode")
    await delay(20)
    s.app.bus.subscribeUser(b.user.id, () => {})()
    await api(s.base, "/api/me/settings", { token: b.token, body: { ghostMode: false } })
    const after = (await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id]
    assert.equal(after, first, "the visit made in ghost mode left no trace")
  } finally {
    await s.close()
  }
})

test("the time does not reveal a session in progress to someone who cannot see online status", async () => {
  const s = await startTestServer()
  try {
    const { a, b, cid } = await setup(s.base, "ls4")
    s.app.bus.subscribeUser(b.user.id, () => {})()
    const ended = (await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id]
    await api(s.base, "/api/me/settings", { token: b.token, body: { lastSeenPolicy: "nobody", seenTimePolicy: "everyone" } })
    await delay(20)
    const leave = s.app.bus.subscribeUser(b.user.id, () => {})
    s.app.refreshLastSeen()
    const during = (await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json
    assert.deepEqual(during.onlineUserIds.includes(b.user.id), false, "online status stays hidden")
    assert.equal(during.lastSeen[b.user.id], ended, "a still sees the end of the previous session, not now")
    leave()
    const later = (await api(s.base, `/api/conversations/${cid}/presence`, { token: a.token })).json.lastSeen[b.user.id]
    assert.ok(Date.parse(later) > Date.parse(ended), "after leaving, the new time appears")
  } finally {
    await s.close()
  }
})

test("existing choices carry over to the new setting, and a restart closes open sessions", () => {
  const file = join(mkdtempSync(join(tmpdir(), "fx-seen-")), "db.sqlite")
  const first = new Store(file)
  const db = (first as unknown as { db: { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
  first.createUser({ id: "u1", username: "one", passwordHash: "x", displayName: "One", createdAt: new Date().toISOString(), publicKey: null, avatar: null })
  // Simulate a database from before the split: no seen_time_policy column.
  db.exec("ALTER TABLE user_settings DROP COLUMN seen_time_policy")
  db.prepare("INSERT INTO user_settings(user_id,require_invite,ghost_mode,last_seen_policy,calls_policy) VALUES('u1',0,0,'nobody','everyone')").run()
  db.prepare("INSERT INTO privacy_exceptions(user_id,target_id,scope,mode) VALUES('u1','u2','lastSeen','allow')").run()
  // An open session with a heartbeat newer than the last recorded disconnect.
  first.setLastSeen("u1", "2026-09-01T10:00:00.000Z")
  first.touchActive(["u1"], "2026-09-01T12:30:00.000Z")
  first.close()

  const second = new Store(file)
  const settings = second.getUserSettings("u1")
  assert.equal(settings.seenTimePolicy, "nobody", "the old choice now also covers the time")
  assert.equal(second.getPrivacyException("u1", "u2", "seenTime"), "allow", "exceptions are copied")
  assert.equal(second.getLastSeen("u1"), "2026-09-01T12:30:00.000Z", "restart uses the last heartbeat")
  second.close()
})
