// Update manifest for the desktop and Android clients.
//
// Release binaries live in a directory on the server (RELEASES_DIR) and are
// served as plain static files by the reverse proxy under /releases. This module
// only reads the manifest describing them, so publishing a build is a file copy
// plus a manifest edit, with no API restart.

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export type ReleasePlatform = "android" | "linux" | "windows" | "macos"

export interface ReleaseInfo {
  platform: ReleasePlatform
  version: string
  versionCode: number
  url: string
  size: number | null
  sha256: string | null
  notes: string
  mandatory: boolean
  publishedAt: string | null
}

const PLATFORMS: ReleasePlatform[] = ["android", "linux", "windows", "macos"]
const DEFAULT_DIR = "/var/lib/frontierx/releases"
const CACHE_MS = 5000

export function isPlatform(value: unknown): value is ReleasePlatform {
  return typeof value === "string" && (PLATFORMS as string[]).includes(value)
}

export function releasesDir(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.RELEASES_DIR ?? "").trim()
  return configured || DEFAULT_DIR
}

function toInfo(platform: ReleasePlatform, raw: Record<string, unknown>): ReleaseInfo | null {
  const version = String(raw.version ?? "").trim()
  const url = String(raw.url ?? "").trim()
  if (!version || !url) return null
  const versionCodeRaw = Number(raw.versionCode ?? 0)
  const sizeRaw = Number(raw.size ?? 0)
  return {
    platform,
    version,
    versionCode: Number.isFinite(versionCodeRaw) ? Math.floor(versionCodeRaw) : 0,
    url,
    size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : null,
    sha256: raw.sha256 ? String(raw.sha256).trim().toLowerCase() : null,
    notes: raw.notes ? String(raw.notes).slice(0, 2000) : "",
    mandatory: Boolean(raw.mandatory),
    publishedAt: raw.publishedAt ? String(raw.publishedAt) : null,
  }
}

let cache: { readAt: number; mtimeMs: number; releases: Partial<Record<ReleasePlatform, ReleaseInfo>> } | null = null

// The manifest is read from disk at most every few seconds, and re-read
// immediately whenever its modification time changes, so a freshly published
// build is visible without touching the service.
function loadManifest(dir: string): Partial<Record<ReleasePlatform, ReleaseInfo>> {
  const file = join(dir, "manifest.json")
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    cache = null
    return {}
  }
  const now = Date.now()
  if (cache && cache.mtimeMs === mtimeMs && now - cache.readAt < CACHE_MS) return cache.releases
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return cache?.releases ?? {}
  }
  const releases: Partial<Record<ReleasePlatform, ReleaseInfo>> = {}
  for (const platform of PLATFORMS) {
    const entry = parsed[platform]
    if (entry && typeof entry === "object") {
      const info = toInfo(platform, entry as Record<string, unknown>)
      if (info) releases[platform] = info
    }
  }
  cache = { readAt: now, mtimeMs, releases }
  return releases
}

export function latestRelease(
  platform: ReleasePlatform,
  env: Record<string, string | undefined> = process.env,
): ReleaseInfo | null {
  return loadManifest(releasesDir(env))[platform] ?? null
}

// Dotted numeric comparison: 0.2.0 is newer than 0.1.9, and 0.2 equals 0.2.0.
// Anything non-numeric in a segment is treated as 0, which keeps the check
// predictable for release names like "1.0.0-rc1".
export function compareVersions(a: string, b: string): number {
  const left = String(a ?? "").split(/[.\-+]/)
  const right = String(b ?? "").split(/[.\-+]/)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = Number.parseInt(left[i] ?? "0", 10)
    const r = Number.parseInt(right[i] ?? "0", 10)
    const lv = Number.isFinite(l) ? l : 0
    const rv = Number.isFinite(r) ? r : 0
    if (lv !== rv) return lv < rv ? -1 : 1
  }
  return 0
}

// Android ships a monotonic versionCode, which is the authoritative signal when
// both sides provide it; desktop builds only carry a dotted version string.
export function isNewerThan(
  latest: ReleaseInfo,
  current: { version: string; versionCode?: number | null },
): boolean {
  if (latest.versionCode > 0 && current.versionCode && current.versionCode > 0) {
    return latest.versionCode > current.versionCode
  }
  if (!current.version) return true
  return compareVersions(latest.version, current.version) > 0
}