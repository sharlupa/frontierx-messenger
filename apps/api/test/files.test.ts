import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, registerUser } from "./helpers"

async function setupConversation(base: string) {
  const alice = await registerUser(base, "alice")
  const conv = await api(base, "/api/conversations", {
    token: alice.token,
    body: { kind: "group", title: "Files" },
  })
  return { alice, cid: conv.json.conversation.id as string }
}

function blobUrl(base: string, id: string): string {
  return base + "/api/files/" + id + "/blob"
}

async function uploadEncryptedBlob(base: string, id: string, token: string, bytes = new Uint8Array([7, 8, 9])) {
  return fetch(blobUrl(base, id), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
    body: bytes,
  })
}

test("a new file asset starts with a LOCAL_AVAILABLE replica", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, cid } = await setupConversation(s.base)
  const file = await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "photo.jpg", mime: "image/jpeg", size: 1024 },
  })
  assert.equal(file.status, 201)
  assert.equal(file.json.replica.state, "LOCAL_AVAILABLE")
  assert.equal(file.json.asset.name, "photo.jpg")
})

test("full backup then verified restore lifecycle over HTTP", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, cid } = await setupConversation(s.base)
  const file = await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "doc.pdf", mime: "application/pdf", size: 2048 },
  })
  const id = file.json.asset.id as string
  const step = (suffix: string) =>
    api(s.base, `/api/files/${id}/${suffix}`, { token: alice.token, method: "POST" })

  assert.equal((await step("backup/begin")).json.replica.state, "BACKUP_UPLOADING")
  assert.equal((await uploadEncryptedBlob(s.base, id, alice.token)).status, 200)
  const uploaded = await step("backup/complete")
  assert.equal(uploaded.json.replica.state, "TEMP_SERVER_BACKUP")
  assert.ok(uploaded.json.replica.tempExpiresAt && uploaded.json.replica.tempExpiresAt > Date.now())
  assert.equal((await step("restore/begin")).json.replica.state, "RESTORING")
  const restored = await step("restore/complete")
  assert.equal(restored.json.replica.state, "LOCAL_AVAILABLE")
  assert.equal(restored.json.replica.tempExpiresAt, null)
  const afterRestore = await fetch(blobUrl(s.base, id), { headers: { authorization: "Bearer " + alice.token } })
  assert.equal(afterRestore.status, 404)
})

test("backup cannot be confirmed until encrypted bytes exist", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, cid } = await setupConversation(s.base)
  const file = await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "backup.bin", mime: "application/octet-stream", size: 10 },
  })
  const id = file.json.asset.id as string
  const step = (suffix: string) => api(s.base, `/api/files/${id}/${suffix}`, { token: alice.token, method: "POST" })
  assert.equal((await step("backup/begin")).json.replica.state, "BACKUP_UPLOADING")
  const withoutBlob = await step("backup/complete")
  assert.equal(withoutBlob.status, 409)
  assert.equal((await step("backup/fail")).json.replica.state, "LOCAL_AVAILABLE")
})

test("illegal transitions are rejected with 409", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, cid } = await setupConversation(s.base)
  const file = await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "a.bin", mime: "application/octet-stream", size: 10 },
  })
  const id = file.json.asset.id as string
  const bad = await api(s.base, `/api/files/${id}/backup/complete`, { token: alice.token, method: "POST" })
  assert.equal(bad.status, 409)
})

test("non-members cannot create files in a conversation", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { cid } = await setupConversation(s.base)
  const mallory = await registerUser(s.base, "mallory")
  const result = await api(s.base, "/api/files", {
    token: mallory.token,
    body: { conversationId: cid, name: "x", mime: "text/plain", size: 1 },
  })
  assert.equal(result.status, 403)
})

test("conversation file list returns member files with replicas", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, cid } = await setupConversation(s.base)
  await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "one.jpg", mime: "image/jpeg", size: 111 },
  })
  await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "two.pdf", mime: "application/pdf", size: 222 },
  })
  const list = await api(s.base, `/api/conversations/${cid}/files`, { token: alice.token })
  assert.equal(list.status, 200)
  assert.equal(list.json.files.length, 2)
  const names = list.json.files.map((f: any) => f.asset.name).sort()
  assert.deepEqual(names, ["one.jpg", "two.pdf"])
  for (const file of list.json.files) {
    assert.equal(file.replica.state, "LOCAL_AVAILABLE")
    assert.ok(file.asset.id)
  }
})

test("non-members cannot list conversation files", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { cid } = await setupConversation(s.base)
  const mallory = await registerUser(s.base, "mallory")
  const result = await api(s.base, `/api/conversations/${cid}/files`, { token: mallory.token })
  assert.equal(result.status, 403)
})
