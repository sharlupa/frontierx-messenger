import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, registerUser } from "./helpers"

async function setup(base: string) {
  const alice = await registerUser(base, "alice")
  const conv = await api(base, "/api/conversations", {
    token: alice.token,
    body: { kind: "group", title: "Blobs" },
  })
  const cid = conv.json.conversation.id as string
  const file = await api(base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "photo.png", mime: "image/png", size: 3000 },
  })
  return { alice, cid, id: file.json.asset.id as string }
}

function blobUrl(base: string, id: string): string {
  return base + "/api/files/" + id + "/blob"
}

test("owner can upload and download encrypted blob bytes", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, id } = await setup(s.base)
  const bytes = crypto.getRandomValues(new Uint8Array(3000))
  const up = await fetch(blobUrl(s.base, id), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer " + alice.token },
    body: bytes,
  })
  assert.equal(up.status, 200)
  const upJson = await up.json()
  assert.equal(upJson.ok, true)
  assert.equal(upJson.bytes, bytes.length)
  const down = await fetch(blobUrl(s.base, id), {
    headers: { authorization: "Bearer " + alice.token },
  })
  assert.equal(down.status, 200)
  const back = new Uint8Array(await down.arrayBuffer())
  assert.equal(back.length, bytes.length)
  assert.deepEqual(Array.from(back), Array.from(bytes))
})

test("downloading a blob that was never uploaded returns 404", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { alice, id } = await setup(s.base)
  const down = await fetch(blobUrl(s.base, id), {
    headers: { authorization: "Bearer " + alice.token },
  })
  assert.equal(down.status, 404)
})

test("a non-member cannot upload blob bytes", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { id } = await setup(s.base)
  const mallory = await registerUser(s.base, "mallory")
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const up = await fetch(blobUrl(s.base, id), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer " + mallory.token },
    body: bytes,
  })
  assert.equal(up.status, 403)
})

test("oversized blob uploads preserve the previous complete blob", async (t) => {
  const s = await startTestServer({ limits: { maxBlobBytes: 3 } })
  t.after(() => s.close())
  const { alice, id } = await setup(s.base)
  const original = new Uint8Array([7, 8, 9])
  const first = await fetch(blobUrl(s.base, id), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer " + alice.token },
    body: original,
  })
  assert.equal(first.status, 200)

  const oversized = await fetch(blobUrl(s.base, id), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer " + alice.token },
    body: new Uint8Array([1, 2, 3, 4]),
  })
  assert.equal(oversized.status, 413)

  const after = await fetch(blobUrl(s.base, id), { headers: { authorization: "Bearer " + alice.token } })
  assert.equal(after.status, 200)
  assert.deepEqual(Array.from(new Uint8Array(await after.arrayBuffer())), Array.from(original))
})
