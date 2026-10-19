import { test } from "node:test"
import assert from "node:assert/strict"
import { api, directConversation, registerUser, startTestServer } from "./helpers"

// a and b are contacts and share a group with c; d knows nobody.
async function setup(base: string, prefix: string) {
  const { a, b, cid } = await directConversation(base, prefix + "a", prefix + "b")
  const c = await registerUser(base, prefix + "c")
  const d = await registerUser(base, prefix + "d")
  await api(base, "/api/friends/requests", { token: a.token, body: { username: c.user.username } })
  await api(base, "/api/friends/requests", { token: c.token, body: { username: a.user.username } })
  const group = await api(base, "/api/conversations", { token: a.token, body: { kind: "group", title: "Team", memberUsernames: [b.user.username, c.user.username] } })
  return { a, b, c, d, cid, gid: group.json.conversation.id as string }
}

test("profile fields are optional and validated", async () => {
  const s = await startTestServer()
  try {
    const { a } = await setup(s.base, "pf1")
    const bio = await api(s.base, "/api/me/profile", { token: a.token, body: { bio: "  Hello\r\n\n\n\nworld\u0007  " } })
    assert.equal(bio.status, 200)
    assert.equal(bio.json.user.bio, "Hello\n\nworld", "line breaks are kept, runs collapse, control characters go")
    assert.equal(bio.json.user.displayName, a.user.displayName, "the name stays when it is not sent")
    assert.equal((await api(s.base, "/api/me/profile", { token: a.token, body: { bio: "x".repeat(201) } })).status, 400)
    assert.equal((await api(s.base, "/api/me/profile", { token: a.token, body: { displayName: "" } })).status, 400)
    const cleared = await api(s.base, "/api/me/profile", { token: a.token, body: { bio: "" } })
    assert.equal(cleared.json.user.bio, null)
    const me = await api(s.base, "/api/me", { token: a.token })
    assert.equal(me.json.user.bio, null)
    assert.equal(me.json.user.personalChannelId, null)
  } finally {
    await s.close()
  }
})

test("a profile is visible only to people who share a chat", async () => {
  const s = await startTestServer()
  try {
    const { a, b, c, d, cid, gid } = await setup(s.base, "pf2")
    await api(s.base, "/api/me/profile", { token: b.token, body: { bio: "About b" } })
    const fromA = await api(s.base, `/api/users/${b.user.id}/profile`, { token: a.token })
    assert.equal(fromA.status, 200)
    assert.equal(fromA.json.user.bio, "About b")
    assert.equal(fromA.json.directConversationId, cid)
    assert.deepEqual(fromA.json.commonGroups.map((g: { id: string }) => g.id), [gid])
    assert.equal(fromA.json.commonGroups[0].memberCount, 3)
    assert.equal(fromA.json.user.passwordHash, undefined)

    const fromC = await api(s.base, `/api/users/${b.user.id}/profile`, { token: c.token })
    assert.equal(fromC.status, 200, "a group co-member sees the profile")
    assert.equal(fromC.json.directConversationId, null)

    assert.equal((await api(s.base, `/api/users/${b.user.id}/profile`, { token: d.token })).status, 404, "a stranger does not")
    assert.equal((await api(s.base, `/api/users/nope/profile`, { token: a.token })).status, 404)
    const own = await api(s.base, `/api/users/${b.user.id}/profile`, { token: b.token })
    assert.equal(own.status, 200)
    assert.deepEqual(own.json.commonGroups, [])
  } finally {
    await s.close()
  }
})

test("a personal channel must be run by its owner and can be joined from the profile", async () => {
  const s = await startTestServer()
  try {
    const { a, b, c, d } = await setup(s.base, "pf3")
    const channel = await api(s.base, "/api/conversations", { token: b.token, body: { kind: "channel", title: "B news", memberUsernames: [] } })
    const channelId = channel.json.conversation.id as string
    const group = await api(s.base, "/api/conversations", { token: b.token, body: { kind: "group", title: "Not a channel", memberUsernames: [] } })
    assert.equal((await api(s.base, "/api/me/profile", { token: b.token, body: { personalChannelId: group.json.conversation.id } })).status, 400, "only channels")
    assert.equal((await api(s.base, "/api/me/profile", { token: a.token, body: { personalChannelId: channelId } })).status, 400, "only channels one runs")

    const managed = await api(s.base, "/api/me/channels", { token: b.token })
    assert.deepEqual(managed.json.channels.map((ch: { id: string }) => ch.id), [channelId])

    const set = await api(s.base, "/api/me/profile", { token: b.token, body: { personalChannelId: channelId } })
    assert.equal(set.status, 200)
    assert.equal(set.json.user.personalChannelId, channelId)
    await api(s.base, `/api/conversations/${channelId}/profile`, { token: b.token, body: { description: "Daily news" } })

    const seen = await api(s.base, `/api/users/${b.user.id}/profile`, { token: c.token })
    assert.equal(seen.json.personalChannel.id, channelId)
    assert.equal(seen.json.personalChannel.description, "Daily news")
    assert.equal(seen.json.personalChannel.isMember, false)

    assert.equal((await api(s.base, `/api/users/${b.user.id}/channel/join`, { token: d.token, body: {} })).status, 404, "a stranger cannot join through the profile")
    const join = await api(s.base, `/api/users/${b.user.id}/channel/join`, { token: c.token, body: {} })
    assert.equal(join.status, 200)
    assert.equal(join.json.conversation.id, channelId)
    const members = await api(s.base, `/api/conversations/${channelId}/members`, { token: c.token })
    assert.equal(members.json.members.find((m: { userId: string }) => m.userId === c.user.id)?.role, "member")
    assert.equal((await api(s.base, `/api/users/${b.user.id}/profile`, { token: c.token })).json.personalChannel.isMember, true)

    // A channel the owner no longer runs drops off the profile.
    await api(s.base, `/api/conversations/${channelId}/delete`, { token: b.token, body: {} })
    assert.equal((await api(s.base, `/api/users/${b.user.id}/profile`, { token: a.token })).json.personalChannel, null)
  } finally {
    await s.close()
  }
})

test("groups and channels carry a description only moderators edit", async () => {
  const s = await startTestServer()
  try {
    const { a, b, gid } = await setup(s.base, "pf4")
    assert.equal((await api(s.base, `/api/conversations/${gid}/profile`, { token: b.token, body: { description: "nope" } })).status, 403)
    assert.equal((await api(s.base, `/api/conversations/${gid}/profile`, { token: a.token, body: { description: "y".repeat(501) } })).status, 400)
    const saved = await api(s.base, `/api/conversations/${gid}/profile`, { token: a.token, body: { description: "  Our team chat  " } })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.conversation.description, "Our team chat")
    const listed = await api(s.base, "/api/conversations", { token: b.token })
    assert.equal(listed.json.conversations.find((c: { id: string }) => c.id === gid)?.description, "Our team chat")
    const invite = await api(s.base, `/api/conversations/${gid}/invite`, { token: a.token, body: {} })
    const preview = await api(s.base, `/api/invites/${invite.json.code}`, {})
    assert.equal(preview.json.description, "Our team chat")
    const cleared = await api(s.base, `/api/conversations/${gid}/profile`, { token: a.token, body: { description: "" } })
    assert.equal(cleared.json.conversation.description, null)
  } finally {
    await s.close()
  }
})
