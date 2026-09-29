import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, registerUser } from "./helpers"
import { MAX_FILE_BYTES, TEMP_BACKUP_QUOTA_BYTES, STICKER_GIF_QUOTA_BYTES } from "../src/limits"

async function uploadEncryptedBlob(base: string, id: string, token: string, bytes: Uint8Array): Promise<Response> {
  return fetch(base + "/api/files/" + id + "/blob", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer " + token },
    body: bytes,
  })
}

test("per-user limits default to 2 GiB file, 2 GiB backup, 500 MiB stickers", () => {
  assert.equal(MAX_FILE_BYTES, 2147483648)
  assert.equal(TEMP_BACKUP_QUOTA_BYTES, 2147483648)
  assert.equal(STICKER_GIF_QUOTA_BYTES, 104857600)
})

test("rejects a file larger than the per-file limit with 413", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  const conv = await api(s.base, "/api/conversations", {
    token: alice.token,
    body: { kind: "group", title: "Files" },
  })
  const cid = conv.json.conversation.id as string
  const tooBig = await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "huge.bin", mime: "application/octet-stream", size: MAX_FILE_BYTES + 1 },
  })
  assert.equal(tooBig.status, 413)
  const ok = await api(s.base, "/api/files", {
    token: alice.token,
    body: { conversationId: cid, name: "small.bin", mime: "application/octet-stream", size: 1024 },
  })
  assert.equal(ok.status, 201)
})

test("backup quota accounts for stored encrypted bytes rather than client-declared size", async (t) => {
  const s = await startTestServer({
    limits: { maxFileBytes: 16, maxBlobBytes: 32, tempBackupQuotaBytes: 4 },
  })
  t.after(() => s.close())
  const alice = await registerUser(s.base, "alice")
  const conv = await api(s.base, "/api/conversations", {
    token: alice.token,
    body: { kind: "group", title: "Backups" },
  })
  const cid = conv.json.conversation.id as string
  const mkFile = async (size: number) => {
    const result = await api(s.base, "/api/files", {
      token: alice.token,
      body: { conversationId: cid, name: "f.bin", mime: "application/octet-stream", size },
    })
    return result.json.asset.id as string
  }
  const backup = (id: string, step: string) =>
    api(s.base, "/api/files/" + id + "/backup/" + step, { token: alice.token, method: "POST" })
  // A malicious client can under-declare metadata size, so quota enforcement
  // must use the bytes actually persisted by the opaque encrypted blob.
  const first = await mkFile(1)
  await backup(first, "begin")
  assert.equal((await uploadEncryptedBlob(s.base, first, alice.token, new Uint8Array([1, 2, 3, 4]))).status, 200)
  const doneFirst = await backup(first, "complete")
  assert.equal(doneFirst.status, 200)
  const second = await mkFile(1)
  await backup(second, "begin")
  assert.equal((await uploadEncryptedBlob(s.base, second, alice.token, new Uint8Array([5]))).status, 200)
  const doneSecond = await backup(second, "complete")
  assert.equal(doneSecond.status, 413)
  assert.equal((await backup(second, "fail")).status, 200)
})
