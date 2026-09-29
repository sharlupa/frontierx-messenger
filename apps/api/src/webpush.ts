import { createECDH, createHash, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto"
import { assertPublicUrl, guardedRequest } from "./netguard.js"

// Standard Web Push (RFC 8030) with VAPID (RFC 8292) and encrypted payloads
// (RFC 8291, aes128gcm). This is what browsers, installed web apps on iOS 16.4
// and later, and Safari on macOS use for background notifications. The push
// service (Apple, Google, Mozilla) only relays an encrypted blob: the payload
// is sealed for the subscribing browser's key and the service cannot read it.

export interface VapidKeys {
  // Uncompressed P-256 point, base64url: what browsers take as applicationServerKey.
  publicKey: string
  privateJwk: JsonWebKey
}

export interface WebPushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

export interface MetaStore {
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
}

const RECORD_SIZE = 4096
const MAX_PAYLOAD = 3000

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/=+$/, ""), "base64url")
}

// Keys come from the environment when set (so several servers can share them),
// otherwise they are created once and kept in the database, which is backed up
// with everything else. Rotating them would silently break every subscription.
export function loadVapidKeys(store: MetaStore): VapidKeys {
  const envPublic = (process.env.VAPID_PUBLIC_KEY ?? "").trim()
  const envPrivate = (process.env.VAPID_PRIVATE_KEY ?? "").trim()
  if (envPublic && envPrivate) {
    const raw = fromB64url(envPublic)
    return { publicKey: envPublic, privateJwk: { kty: "EC", crv: "P-256", d: envPrivate, x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) } }
  }
  const saved = store.getMeta("vapid_keys")
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as VapidKeys
      if (parsed.publicKey && parsed.privateJwk && parsed.privateJwk.d) return parsed
    } catch {
      // regenerate below
    }
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwk = pair.privateKey.export({ format: "jwk" }) as JsonWebKey
  const raw = Buffer.concat([Buffer.from([4]), fromB64url(String(jwk.x)), fromB64url(String(jwk.y))])
  const keys: VapidKeys = { publicKey: b64url(raw), privateJwk: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y } }
  store.setMeta("vapid_keys", JSON.stringify(keys))
  return keys
}

export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const signingInput = header + "." + claims
  const key: KeyObject = createPrivateKey({ key: keys.privateJwk as never, format: "jwk" })
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" })
  return "vapid t=" + signingInput + "." + b64url(signature) + ", k=" + keys.publicKey
}

// RFC 8291: one aes128gcm record sealed for the subscription's key.
export function encryptPayload(subscription: WebPushSubscription, plaintext: Buffer): Buffer {
  const clientPublic = fromB64url(subscription.p256dh)
  const authSecret = fromB64url(subscription.auth)
  if (clientPublic.length !== 65 || clientPublic[0] !== 4) throw new Error("invalid subscription key")
  if (authSecret.length < 16) throw new Error("invalid subscription secret")
  const local = createECDH("prime256v1")
  local.generateKeys()
  const localPublic = local.getPublicKey()
  const shared = local.computeSecret(clientPublic)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPublic, localPublic])
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32))
  const salt = randomBytes(16)
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16))
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12))
  const cipher = createCipheriv("aes-128-gcm", cek, nonce)
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = localPublic.length
  return Buffer.concat([header, localPublic, sealed])
}

export type WebPushResult = "sent" | "gone" | "failed"

export class WebPushSender {
  private keys: VapidKeys | null = null

  constructor(
    private readonly meta: MetaStore,
    private readonly subject = (process.env.VAPID_SUBJECT ?? "").trim() || "https://frontierx.zkito.fun",
  ) {}

  publicKey(): string {
    return this.vapid().publicKey
  }

  private vapid(): VapidKeys {
    if (!this.keys) this.keys = loadVapidKeys(this.meta)
    return this.keys
  }

  async send(subscription: WebPushSubscription, payload: Record<string, unknown>, options: { ttl?: number; urgency?: "normal" | "high"; topic?: string } = {}): Promise<WebPushResult> {
    let url: URL
    try {
      url = assertPublicUrl(subscription.endpoint, { httpsOnly: true })
    } catch {
      return "gone"
    }
    let json = JSON.stringify(payload)
    if (json.length > MAX_PAYLOAD) json = JSON.stringify({ ...payload, body: "" })
    const body = encryptPayload(subscription, Buffer.from(json, "utf8"))
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: String(options.ttl ?? 86400),
      urgency: options.urgency ?? "normal",
      authorization: vapidAuthorization(subscription.endpoint, this.vapid(), this.subject),
    }
    if (options.topic) headers.topic = createHash("sha256").update(options.topic).digest("base64url").slice(0, 32)
    try {
      const response = await guardedRequest(url, { method: "POST", headers, body, timeoutMs: 10000, maxBytes: 16 * 1024, truncate: true })
      if (response.status === 404 || response.status === 410) return "gone"
      return response.status >= 200 && response.status < 300 ? "sent" : "failed"
    } catch {
      return "failed"
    }
  }
}
