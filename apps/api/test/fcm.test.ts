import { test } from "node:test"
import assert from "node:assert/strict"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FcmSender } from "../src/fcm"
import { FCM_PREFIX, PushSender } from "../src/push"

function account() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const dir = mkdtempSync(join(tmpdir(), "fcm-"))
  const file = join(dir, "sa.json")
  writeFileSync(file, JSON.stringify({
    project_id: "frontierx-test",
    client_email: "push@frontierx-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  }))
  return { file, publicKey }
}

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test("fcm is disabled without a service account", () => {
  assert.equal(new FcmSender(undefined).enabled, false)
})

test("fcm signs a valid JWT, caches the token and sends a data message", async () => {
  const { file, publicKey } = account()
  const sender = new FcmSender(file)
  assert.equal(sender.enabled, true)
  const net = mockFetch((url) => {
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }))
    return new Response("{}", { status: 200 })
  })
  try {
    assert.equal(await sender.send("device-token-1", { type: "message", conversationId: "conv_1" }), "sent")
    assert.equal(await sender.send("device-token-2", { type: "call" }, 60), "sent")
    const tokenCalls = net.calls.filter((c) => c.url.includes("oauth2"))
    assert.equal(tokenCalls.length, 1, "access token is cached")
    const assertion = new URLSearchParams(String(tokenCalls[0].init.body)).get("assertion") as string
    const [header, claims, signature] = assertion.split(".")
    const verifier = createVerify("RSA-SHA256")
    verifier.update(header + "." + claims)
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")), "JWT signature verifies")
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString())
    assert.equal(payload.scope, "https://www.googleapis.com/auth/firebase.messaging")
    const send = net.calls.find((c) => c.url.includes("messages:send")) as { url: string; init: RequestInit }
    assert.ok(send.url.includes("/projects/frontierx-test/"))
    assert.equal((send.init.headers as Record<string, string>).authorization, "Bearer ya29.test")
    const body = JSON.parse(String(send.init.body))
    assert.deepEqual(body.message.data, { type: "message", conversationId: "conv_1" })
    assert.equal(body.message.android.priority, "HIGH")
  } finally {
    net.restore()
  }
})

test("a token the device dropped is removed from the store", async () => {
  const { file } = account()
  const deleted: string[] = []
  const store = {
    listPushEndpoints: () => [{ id: "p1", userId: "u1", endpoint: FCM_PREFIX + "stale-token" }],
    deletePushEndpointByUrl: (endpoint: string) => { deleted.push(endpoint) },
  }
  const sender = new PushSender(store, () => false, new FcmSender(file))
  const net = mockFetch((url) => {
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
    return new Response(JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found." } }), { status: 404 })
  })
  try {
    assert.equal(await sender.deliverToUser("u1", { type: "test", title: "FrontierX", body: "hi" }), 0)
    assert.deepEqual(deleted, [FCM_PREFIX + "stale-token"])
  } finally {
    net.restore()
  }
})
