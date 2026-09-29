import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, befriend } from "./helpers"

async function registerWithKey(base: string, username: string, publicKey: string) {
  const r = await api(base, "/api/auth/register", {
    method: "POST",
    body: { username, password: "password123", displayName: username, publicKey },
  })
  return r.json as { token: string; user: { id: string; username: string; publicKey: string | null } }
}

test("public key is stored on register and returned by me", async () => {
  const srv = await startTestServer()
  try {
    const alice = await registerWithKey(srv.base, "alice", "ALICEPUB")
    assert.equal(alice.user.publicKey, "ALICEPUB")
    const me = await api(srv.base, "/api/me", { token: alice.token })
    assert.equal(me.status, 200)
    assert.equal(me.json.user.publicKey, "ALICEPUB")
  } finally {
    await srv.close()
  }
})

test("me/publicKey updates the stored identity key", async () => {
  const srv = await startTestServer()
  try {
    const alice = await registerWithKey(srv.base, "alice", "OLDKEY")
    const upd = await api(srv.base, "/api/me/publicKey", {
      method: "POST",
      token: alice.token,
      body: { publicKey: "NEWKEY" },
    })
    assert.equal(upd.status, 200)
    const me = await api(srv.base, "/api/me", { token: alice.token })
    assert.equal(me.json.user.publicKey, "NEWKEY")
  } finally {
    await srv.close()
  }
})

test("members endpoint exposes public keys and keys wrap per member", async () => {
  const srv = await startTestServer()
  try {
    const alice = await registerWithKey(srv.base, "alice", "ALICEPUB")
    const bob = await registerWithKey(srv.base, "bob", "BOBPUB")
    await befriend(srv.base, alice, bob)
    const conv = await api(srv.base, "/api/conversations", {
      method: "POST",
      token: alice.token,
      body: { kind: "group", title: "Keys", memberUsernames: ["bob"] },
    })
    assert.equal(conv.status, 201)
    const convId = conv.json.conversation.id as string
    const membersRes = await api(srv.base, "/api/conversations/" + convId + "/members", { token: alice.token })
    assert.equal(membersRes.status, 200)
    const members = membersRes.json.members as Array<{ userId: string; publicKey: string | null }>
    const aliceEntry = members.find((m) => m.userId === alice.user.id)
    const bobEntry = members.find((m) => m.userId === bob.user.id)
    assert.equal(aliceEntry?.publicKey, "ALICEPUB")
    assert.equal(bobEntry?.publicKey, "BOBPUB")
    const post = await api(srv.base, "/api/conversations/" + convId + "/keys", {
      method: "POST",
      token: alice.token,
      body: {
        entries: [
          { memberId: alice.user.id, ephemeralPublicKey: "EPHA", iv: "IVA", ciphertext: "CTA" },
          { memberId: bob.user.id, ephemeralPublicKey: "EPHB", iv: "IVB", ciphertext: "CTB" },
        ],
      },
    })
    assert.equal(post.status, 201)
    assert.equal(post.json.count, 2)
    const mine = await api(srv.base, "/api/conversations/" + convId + "/keys/mine", { token: bob.token })
    assert.equal(mine.status, 200)
    assert.equal(mine.json.entry.ciphertext, "CTB")
    assert.equal(mine.json.entry.ephemeralPublicKey, "EPHB")
  } finally {
    await srv.close()
  }
})

test("non-members cannot read or write conversation keys", async () => {
  const srv = await startTestServer()
  try {
    const alice = await registerWithKey(srv.base, "alice", "ALICEPUB")
    const mallory = await registerWithKey(srv.base, "mallory", "MALPUB")
    const conv = await api(srv.base, "/api/conversations", {
      method: "POST",
      token: alice.token,
      body: { kind: "group", title: "Private" },
    })
    const convId = conv.json.conversation.id as string
    const readRes = await api(srv.base, "/api/conversations/" + convId + "/keys/mine", { token: mallory.token })
    assert.equal(readRes.status, 403)
    const writeRes = await api(srv.base, "/api/conversations/" + convId + "/keys", {
      method: "POST",
      token: mallory.token,
      body: { entries: [] },
    })
    assert.equal(writeRes.status, 403)
  } finally {
    await srv.close()
  }
})
