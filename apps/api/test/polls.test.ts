import { test } from "node:test"
import assert from "node:assert/strict"
import { api, befriend, registerUser, startTestServer } from "./helpers"

async function setup(base: string) {
  const owner = await registerUser(base, "poll_owner")
  const member = await registerUser(base, "poll_member")
  const outsider = await registerUser(base, "poll_outsider")
  await befriend(base, owner, member)
  const created = await api(base, "/api/conversations", { token: owner.token, body: { kind: "group", title: "Poll group", memberUsernames: ["poll_member"] } })
  return { owner, member, outsider, id: created.json.conversation.id as string }
}

test("encrypted polls persist votes, respect roles, and redact another member's selection", async (t) => {
  const server = await startTestServer()
  t.after(() => server.close())
  const c = await setup(server.base)

  const created = await api(server.base, `/api/conversations/${c.id}/polls`, {
    token: c.owner.token,
    body: { ciphertext: "opaque-encrypted-poll", optionCount: 3, multipleChoice: false, quiz: true },
  })
  assert.equal(created.status, 201)
  const messageId = created.json.message.id as string
  assert.equal(created.json.message.ciphertext, "opaque-encrypted-poll")
  assert.deepEqual(created.json.poll.optionCounts, [0, 0, 0])

  const outsiderList = await api(server.base, `/api/conversations/${c.id}/polls`, { token: c.outsider.token })
  assert.equal(outsiderList.status, 403)
  const invalidVote = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, { token: c.member.token, body: { optionIndexes: [9] } })
  assert.equal(invalidVote.status, 400)
  const multipleOnSingle = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, { token: c.member.token, body: { optionIndexes: [0, 1] } })
  assert.equal(multipleOnSingle.status, 400)

  const vote = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, { token: c.member.token, body: { optionIndexes: [1] } })
  assert.equal(vote.status, 200)
  assert.deepEqual(vote.json.poll.myOptionIndexes, [1])
  assert.deepEqual(vote.json.poll.optionCounts, [0, 1, 0])

  const ownerView = await api(server.base, `/api/conversations/${c.id}/polls`, { token: c.owner.token })
  assert.equal(ownerView.status, 200)
  assert.deepEqual(ownerView.json.polls[0].optionCounts, [0, 1, 0])
  assert.deepEqual(ownerView.json.polls[0].myOptionIndexes, [])
  const memberView = await api(server.base, `/api/conversations/${c.id}/polls`, { token: c.member.token })
  assert.deepEqual(memberView.json.polls[0].myOptionIndexes, [1])

  const restrict = await api(server.base, `/api/conversations/${c.id}/members/${c.member.user.id}/role`, { token: c.owner.token, body: { role: "restricted" } })
  assert.equal(restrict.status, 200)
  const restrictedVote = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, { token: c.member.token, body: { optionIndexes: [2] } })
  assert.equal(restrictedVote.status, 403)
  await api(server.base, `/api/conversations/${c.id}/members/${c.member.user.id}/role`, { token: c.owner.token, body: { role: "member" } })

  const close = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/close`, { token: c.owner.token, body: {} })
  assert.equal(close.status, 200)
  assert.ok(close.json.poll.closedAt)
  const closedVote = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, { token: c.member.token, body: { optionIndexes: [2] } })
  assert.equal(closedVote.status, 409)

  const deleted = await api(server.base, `/api/conversations/${c.id}/messages/${messageId}/delete`, { token: c.owner.token, body: {} })
  assert.equal(deleted.status, 200)
  const afterDelete = await api(server.base, `/api/conversations/${c.id}/polls`, { token: c.owner.token })
  assert.deepEqual(afterDelete.json.polls, [])
})

test("multiple-choice polls update votes and redact realtime selections", async (t) => {
  const server = await startTestServer()
  t.after(() => server.close())
  const c = await setup(server.base)
  const memberEvents: any[] = []
  const ownerEvents: any[] = []
  const unsubscribeMember = server.app.bus.subscribeUser(c.member.user.id, (event) => memberEvents.push(event))
  const unsubscribeOwner = server.app.bus.subscribeUser(c.owner.user.id, (event) => ownerEvents.push(event))
  t.after(() => { unsubscribeMember(); unsubscribeOwner() })

  const created = await api(server.base, `/api/conversations/${c.id}/polls`, {
    token: c.owner.token,
    body: { ciphertext: "opaque-multiple-choice-poll", optionCount: 4, multipleChoice: true, quiz: false },
  })
  assert.equal(created.status, 201)
  const messageId = created.json.message.id as string
  const initialUpdates = memberEvents.filter((event) => event.type === "poll.updated")
  assert.ok(initialUpdates.length > 0)
  assert.equal(Object.prototype.hasOwnProperty.call(initialUpdates[initialUpdates.length - 1].update, "myOptionIndexes"), false)

  const firstVote = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, {
    token: c.member.token,
    body: { optionIndexes: [3, 1, 3] },
  })
  assert.equal(firstVote.status, 200)
  assert.deepEqual(firstVote.json.poll.myOptionIndexes, [1, 3])
  assert.deepEqual(firstVote.json.poll.optionCounts, [0, 1, 0, 1])
  assert.equal(firstVote.json.poll.totalVoters, 1)

  const voteUpdates = memberEvents.filter((event) => event.type === "poll.updated")
  const realtimeUpdate = voteUpdates[voteUpdates.length - 1]
  assert.equal(Object.prototype.hasOwnProperty.call(realtimeUpdate.update, "myOptionIndexes"), false)
  assert.deepEqual(realtimeUpdate.update.optionCounts, [0, 1, 0, 1])

  const replacementVote = await api(server.base, `/api/conversations/${c.id}/polls/${messageId}/vote`, {
    token: c.member.token,
    body: { optionIndexes: [2] },
  })
  assert.equal(replacementVote.status, 200)
  assert.deepEqual(replacementVote.json.poll.myOptionIndexes, [2])
  assert.deepEqual(replacementVote.json.poll.optionCounts, [0, 0, 1, 0])
  assert.equal(replacementVote.json.poll.totalVoters, 1)

  const ownerView = await api(server.base, `/api/conversations/${c.id}/polls`, { token: c.owner.token })
  assert.deepEqual(ownerView.json.polls[0].myOptionIndexes, [])
  const memberView = await api(server.base, `/api/conversations/${c.id}/polls`, { token: c.member.token })
  assert.deepEqual(memberView.json.polls[0].myOptionIndexes, [2])
  const ownerUpdates = ownerEvents.filter((event) => event.type === "poll.updated")
  assert.equal(Object.prototype.hasOwnProperty.call(ownerUpdates[ownerUpdates.length - 1].update, "myOptionIndexes"), false)
})

test("channel members can vote without channel posting permission", async (t) => {
  const server = await startTestServer()
  t.after(() => server.close())
  const owner = await registerUser(server.base, "channel_poll_owner")
  const member = await registerUser(server.base, "channel_poll_member")
  await befriend(server.base, owner, member)
  const channel = await api(server.base, "/api/conversations", {
    token: owner.token,
    body: { kind: "channel", title: "Poll channel", memberUsernames: ["channel_poll_member"] },
  })
  assert.equal(channel.status, 201)
  const conversationId = channel.json.conversation.id as string

  const forbiddenCreate = await api(server.base, `/api/conversations/${conversationId}/polls`, {
    token: member.token,
    body: { ciphertext: "member-cannot-post", optionCount: 2 },
  })
  assert.equal(forbiddenCreate.status, 403)

  const invalidQuiz = await api(server.base, `/api/conversations/${conversationId}/polls`, {
    token: owner.token,
    body: { ciphertext: "invalid-quiz", optionCount: 2, multipleChoice: true, quiz: true },
  })
  assert.equal(invalidQuiz.status, 400)
  const invalidCount = await api(server.base, `/api/conversations/${conversationId}/polls`, {
    token: owner.token,
    body: { ciphertext: "invalid-count", optionCount: 1 },
  })
  assert.equal(invalidCount.status, 400)

  const created = await api(server.base, `/api/conversations/${conversationId}/polls`, {
    token: owner.token,
    body: { ciphertext: "opaque-channel-poll", optionCount: 2, multipleChoice: false, quiz: false },
  })
  assert.equal(created.status, 201)
  const messageId = created.json.message.id as string
  const vote = await api(server.base, `/api/conversations/${conversationId}/polls/${messageId}/vote`, {
    token: member.token,
    body: { optionIndexes: [1] },
  })
  assert.equal(vote.status, 200)
  assert.deepEqual(vote.json.poll.myOptionIndexes, [1])

  const forbiddenClose = await api(server.base, `/api/conversations/${conversationId}/polls/${messageId}/close`, {
    token: member.token,
    body: {},
  })
  assert.equal(forbiddenClose.status, 403)
})
