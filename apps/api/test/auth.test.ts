import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, api, registerUser } from "./helpers"

test("register issues a token and returns a safe public user", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const r = await api(s.base, "/api/auth/register", {
    body: { username: "alice", password: "password123", displayName: "Alice" },
  })
  assert.equal(r.status, 201)
  assert.ok(r.json.token)
  assert.equal(r.json.user.username, "alice")
  assert.equal(r.json.user.displayName, "Alice")
  assert.ok(!("passwordHash" in r.json.user))
})

test("duplicate usernames are rejected", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await registerUser(s.base, "bob")
  const r = await api(s.base, "/api/auth/register", { body: { username: "bob", password: "password123" } })
  assert.equal(r.status, 409)
})

test("login succeeds with the right password and fails otherwise", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  await registerUser(s.base, "carol", "correct-horse-battery")
  const good = await api(s.base, "/api/auth/login", {
    body: { username: "carol", password: "correct-horse-battery" },
  })
  assert.equal(good.status, 200)
  assert.ok(good.json.token)
  const bad = await api(s.base, "/api/auth/login", { body: { username: "carol", password: "wrong" } })
  assert.equal(bad.status, 401)
})

test("/api/me requires a valid bearer token", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const { token } = await registerUser(s.base, "dave")
  const me = await api(s.base, "/api/me", { token })
  assert.equal(me.status, 200)
  assert.equal(me.json.user.username, "dave")
  assert.equal((await api(s.base, "/api/me", {})).status, 401)
  assert.equal((await api(s.base, "/api/me", { token: "garbage" })).status, 401)
})

test("weak passwords and invalid usernames are rejected", async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  assert.equal(
    (await api(s.base, "/api/auth/register", { body: { username: "erin", password: "short" } })).status,
    400,
  )
  assert.equal(
    (await api(s.base, "/api/auth/register", { body: { username: "e", password: "password123" } })).status,
    400,
  )
})
