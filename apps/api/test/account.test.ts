import { test } from "node:test"
import assert from "node:assert/strict"
import { api, registerUser, startTestServer } from "./helpers"

test("profiles and browser sessions are durable, private, and revocable", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())

  const first = await registerUser(s.base, "accountalice")
  const second = await api(s.base, "/api/auth/login", {
    body: { username: "accountalice", password: "password123" },
  })
  assert.equal(second.status, 200)

  const profile = await api(s.base, "/api/me/profile", {
    token: first.token,
    body: { displayName: "Alice Updated" },
  })
  assert.equal(profile.status, 200)
  assert.equal(profile.json.user.displayName, "Alice Updated")
  assert.equal((await api(s.base, "/api/me", { token: first.token })).json.user.displayName, "Alice Updated")

  const listed = await api(s.base, "/api/me/sessions", { token: first.token })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.sessions.length, 2)
  assert.ok(listed.json.sessions.every((session: any) => session.id && session.label && session.current !== undefined))
  assert.ok(listed.json.sessions.every((session: any) => !("tokenHash" in session)))
  const current = listed.json.sessions.find((session: any) => session.current)
  const other = listed.json.sessions.find((session: any) => !session.current)
  assert.ok(current)
  assert.ok(other)

  const revoked = await api(s.base, `/api/me/sessions/${other.id}/revoke`, { token: first.token, body: {} })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.json.currentSessionRevoked, false)
  assert.equal((await api(s.base, "/api/me", { token: second.json.token })).status, 401)
  assert.equal((await api(s.base, "/api/me", { token: first.token })).status, 200)

  const third = await api(s.base, "/api/auth/login", {
    body: { username: "accountalice", password: "password123" },
  })
  assert.equal(third.status, 200)
  const outsider = await registerUser(s.base, "accountbob")
  const outsiderSessions = await api(s.base, "/api/me/sessions", { token: outsider.token })
  const crossAccount = await api(s.base, `/api/me/sessions/${outsiderSessions.json.sessions[0].id}/revoke`, { token: first.token, body: {} })
  assert.equal(crossAccount.status, 404)

  const revokeOthers = await api(s.base, "/api/me/sessions/revoke-others", { token: first.token, body: {} })
  assert.equal(revokeOthers.status, 200)
  assert.equal(revokeOthers.json.revoked, 1)
  assert.equal((await api(s.base, "/api/me", { token: third.json.token })).status, 401)
  assert.equal((await api(s.base, "/api/me", { token: first.token })).status, 200)
})

test("profile changes reject blank and oversized display names", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const user = await registerUser(s.base, "accountcarol")
  assert.equal((await api(s.base, "/api/me/profile", { token: user.token, body: { displayName: "   " } })).status, 400)
  assert.equal((await api(s.base, "/api/me/profile", { token: user.token, body: { displayName: "x".repeat(65) } })).status, 400)
})
