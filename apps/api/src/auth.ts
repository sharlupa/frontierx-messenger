import { randomBytes, createHash } from "node:crypto"
import { hashPassword, verifyPassword } from "@frontierx/crypto"
import { newId } from "@frontierx/shared"
import { HttpError } from "./errors.js"
import type { Store, UserRow, SessionRow } from "./store.js"

// Password hashing (scrypt) lives in @frontierx/crypto. Here we add session
// tokens: a random 256-bit token is returned to the client; only its SHA-256
// hash is stored, so a database leak does not reveal live tokens. Sessions are
// pinned to a device id so the same browser reuses one row, and they persist
// until the user revokes the device.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/

export interface PublicUser {
  id: string
  username: string
  displayName: string
  publicKey: string | null
  avatar: string | null
  isBot?: boolean
}
export interface AuthResult {
  token: string
  user: PublicUser
}

export function publicUser(u: UserRow): PublicUser {
  const out: PublicUser = { id: u.id, username: u.username, displayName: u.displayName, publicKey: u.publicKey ?? null, avatar: u.avatar ?? null }
  if (u.isBot) out.isBot = true
  return out
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function normalizeSessionLabel(label: string | undefined): string {
  const value = (label ?? "").replace(/\s+/g, " ").trim()
  return value ? value.slice(0, 120) : "Browser session"
}

function normalizeDeviceId(deviceId: string | undefined): string | null {
  const value = (deviceId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").trim()
  return value ? value.slice(0, 64) : null
}

export function issueSession(store: Store, userId: string, label?: string, deviceId?: string): string {
  const token = randomBytes(32).toString("base64url")
  const now = Date.now()
  const createdAt = new Date(now).toISOString()
  const device = normalizeDeviceId(deviceId)
  if (device) store.deleteSessionsForDevice(userId, device)
  store.createSession({
    id: newId("sess"),
    tokenHash: hashToken(token),
    userId,
    label: normalizeSessionLabel(label),
    createdAt,
    lastSeenAt: createdAt,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    deviceId: device,
  })
  return token
}

export function register(store: Store, username: string, password: string, displayName?: string, publicKey?: string, sessionLabel?: string, deviceId?: string): AuthResult {
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "username must be 3-32 characters: letters, digits, underscore or dot")
  }
  if (typeof password !== "string" || password.length < 8) {
    throw new HttpError(400, "password must be at least 8 characters")
  }
  if (store.getUserByUsername(username)) throw new HttpError(409, "username is taken")
  const trimmed = displayName && displayName.trim() ? displayName.trim() : username
  const user: UserRow = {
    id: newId("user"),
    username,
    passwordHash: hashPassword(password),
    displayName: trimmed.slice(0, 64),
    createdAt: new Date().toISOString(),
    publicKey: publicKey ?? null,
    avatar: null,
  }
  store.createUser(user)
  return { token: issueSession(store, user.id, sessionLabel, deviceId), user: publicUser(user) }
}

export function login(store: Store, username: string, password: string, sessionLabel?: string, deviceId?: string): AuthResult {
  const user = store.getUserByUsername(username)
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, "invalid credentials")
  }
  return { token: issueSession(store, user.id, sessionLabel, deviceId), user: publicUser(user) }
}

export function authenticateSession(store: Store, authHeader: string | undefined): SessionRow {
  if (!authHeader || !authHeader.startsWith("Bearer ")) throw new HttpError(401, "missing bearer token")
  const token = authHeader.slice("Bearer ".length).trim()
  if (!token) throw new HttpError(401, "missing bearer token")
  const session = store.getSession(hashToken(token))
  if (!session) throw new HttpError(401, "invalid or expired token")
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    store.deleteSession(session.tokenHash)
    throw new HttpError(401, "session expired")
  }
  const lastSeenAt = new Date().toISOString()
  store.touchSession(session.tokenHash, lastSeenAt)
  return { ...session, lastSeenAt }
}

export function authenticate(store: Store, authHeader: string | undefined): string {
  return authenticateSession(store, authHeader).userId
}
