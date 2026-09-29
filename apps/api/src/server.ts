import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { deleteBlob } from "./blobstore.js"
import { createReadStream, existsSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import { createApp } from "./app.js"
import { attachWebSocket } from "./ws.js"

// Baseline hardening for every response this process emits. These values are
// merged with the per-route writeHead() headers, which win on conflicts, so
// content-type and cache-control keep working untouched. HSTS is only sent over
// TLS, and the policy has to keep the app working: the inline boot script on the
// landing page, blob media for calls and screen sharing, ws for realtime.
const SECURITY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Map tiles for shared places come straight from OpenStreetMap.
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ")

const requestIsHttps = (req: IncomingMessage): boolean => {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase()
  if (forwarded !== "") return forwarded === "https"
  const socket = req.socket as { encrypted?: boolean }
  return socket.encrypted === true
}

const applySecurityHeaders = (req: IncomingMessage, res: ServerResponse): void => {
  res.setHeader("x-content-type-options", "nosniff")
  res.setHeader("x-frame-options", "SAMEORIGIN")
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin")
  res.setHeader("cross-origin-opener-policy", "same-origin")
  res.setHeader("content-security-policy", SECURITY_CSP)
  res.setHeader(
    "permissions-policy",
    "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=(self), payment=(), usb=()",
  )
  if (requestIsHttps(req)) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains")
}

// Runnable entrypoint: a real HTTP server plus the WebSocket upgrade handler,
// backed by an on-disk SQLite database. Besides the JSON API under /api and the
// /ws realtime endpoint, this process also serves the built web client
// (apps/web/dist) as static files, so the whole app runs from a single origin
// on a single port. That keeps deployment - and Cloudflare quick tunnels -
// simple: no second web server, no dev-server host checks, no cross-origin proxy.

const port = Number(process.env.PORT ?? 8080)
// Keep the API off the public interface by default. A reverse proxy or a local
// tunnel is the edge; opt in to another bind address with HOST=0.0.0.0.
const host = process.env.HOST ?? "127.0.0.1"
const dbPath = process.env.DB_PATH ?? "frontierx.db"

// Where the built web client lives. Defaults to apps/web/dist resolved from
// this file; override with WEB_DIR. Set WEB_DIR="" to disable static serving.
const defaultWebDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist")
const webDir =
  process.env.WEB_DIR === undefined
    ? defaultWebDir
    : process.env.WEB_DIR
      ? resolve(process.env.WEB_DIR)
      : ""
const webEnabled = webDir !== "" && existsSync(join(webDir, "index.html"))

// Release binaries live outside the web bundle and are downloaded straight
// from this process under /releases, so the reverse proxy needs no extra rule
// and publishing a build stays a file copy plus a manifest edit.
const releasesRoot = resolve((process.env.RELEASES_DIR ?? "").trim() || "/var/lib/frontierx/releases")

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  // Documentation (the bot SDK's README) opens as text in the browser.
  ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".apk": "application/vnd.android.package-archive",
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
}

// Serve a file from the built web client. Returns true when it has written a
// response (a real file or the SPA fallback), and false when the request must
// be handled by the API listener instead.
function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (!webEnabled) return false
  const method = req.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") return false

  const rawPath = (req.url ?? "/").split("?")[0]
  // Everything under /api is the JSON API; /ws is the realtime upgrade. Never let
  // the static layer or the SPA fallback shadow them.
  if (rawPath === "/api" || rawPath.startsWith("/api/") || rawPath === "/ws") return false

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    decoded = rawPath
  }

  let relative = decoded
  while (relative.startsWith("/")) relative = relative.slice(1)

  const candidate = normalize(join(webDir, relative))
  // Guard against path traversal: the resolved path must stay inside webDir.
  const withinRoot = candidate === webDir || candidate.startsWith(webDir + sep)

  let filePath = candidate
  if (!withinRoot || relative === "" || !existsSync(filePath) || !statSync(filePath).isFile()) {
    // Unknown client-side route or missing asset -> serve the SPA shell.
    filePath = join(webDir, "index.html")
  }

  const isHtml = filePath.endsWith(".html")
  const headers: Record<string, string> = { "content-type": contentTypeFor(filePath), "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "SAMEORIGIN" }
  // Vite emits content-hashed asset filenames, so they can be cached forever;
  // index.html must always revalidate so new builds are picked up.
  if (!isHtml && rawPath.startsWith("/assets/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable"
  } else if (isHtml) {
    headers["cache-control"] = "no-cache"
  }

  res.writeHead(200, headers)
  if (method === "HEAD") {
    res.end()
    return true
  }
  const stream = createReadStream(filePath)
  stream.on("error", () => {
    res.end()
  })
  stream.pipe(res)
  return true
}

// Serve a release file or the manifest. Installers are large, so HEAD and a
// single byte range are supported to allow resuming an interrupted download.
function serveRelease(req: IncomingMessage, res: ServerResponse, rawPath: string): boolean {
  const method = req.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") return false
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    decoded = rawPath
  }
  let relative = decoded.slice("/releases/".length)
  while (relative.startsWith("/")) relative = relative.slice(1)
  const candidate = normalize(join(releasesRoot, relative))
  let size = -1
  if (relative && candidate.startsWith(releasesRoot + sep) && existsSync(candidate)) {
    const stat = statSync(candidate)
    if (stat.isFile()) size = stat.size
  }
  if (size < 0) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify({ error: "release not found" }))
    return true
  }
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(candidate),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": candidate.endsWith(".json") ? "no-cache" : "public, max-age=86400",
  }
  let start = 0
  let end = size > 0 ? size - 1 : 0
  let status = 200
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""))
  if (range && size > 0) {
    const from = range[1]
    const to = range[2]
    if (from === "" && to !== "") start = Math.max(0, size - Number(to))
    else {
      start = Number(from || 0)
      if (to !== "") end = Math.min(end, Number(to))
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { "content-range": "bytes */" + size })
      res.end()
      return true
    }
    status = 206
    headers["content-range"] = "bytes " + start + "-" + end + "/" + size
  }
  headers["content-length"] = String(size === 0 ? 0 : end - start + 1)
  res.writeHead(status, headers)
  if (method === "HEAD" || size === 0) {
    res.end()
    return true
  }
  const stream = createReadStream(candidate, { start, end })
  stream.on("error", () => {
    res.end()
  })
  stream.pipe(res)
  return true
}

const app = createApp({ dbPath })

// >>> frontierx-landing
const siteDir = resolve((process.env.SITE_DIR ?? "").trim() || "/opt/frontierx/site")
const sitePages: Record<string, string> = {
	"/": "index.html",
	"/home": "index.html",
	"/home/": "index.html",
	"/download": "download.html",
	"/download/": "download.html",
	"/features": "features.html",
	"/features/": "features.html",
	"/changes": "changes.html",
	"/changes/": "changes.html",
	"/changelog": "changes.html",
	"/privacy": "privacy.html",
	"/delete-account": "delete-account.html",
	"/delete-account/": "delete-account.html",
	"/privacy/": "privacy.html",
}
const sendSiteFile = (req: IncomingMessage, res: ServerResponse, file: string): boolean => {
	if (!existsSync(file)) return false
	const stat = statSync(file)
	if (!stat.isFile()) return false
	const isHtml = file.endsWith(".html")
	res.writeHead(200, {
		"content-type": contentTypeFor(file),
		"content-length": String(stat.size),
		"cache-control": isHtml ? "no-cache" : "public, max-age=3600",
		"x-content-type-options": "nosniff",
	})
	if (req.method === "HEAD") {
		res.end()
		return true
	}
	createReadStream(file).pipe(res)
	return true
}
// >>> fx-app-entry
const isAppClient = (req: IncomingMessage): boolean => {
	const u = req.url ?? "/"
	const q = u.includes("?") ? u.slice(u.indexOf("?") + 1) : ""
	if (q.split("&").includes("app=1")) return true
	const ua = String(req.headers["user-agent"] ?? "").toLowerCase()
	if (ua.includes("; wv)")) return true
	return ua.includes("frontierx-app")
}
// <<< fx-app-entry
const serveSite = (req: IncomingMessage, res: ServerResponse, rawPath: string): boolean => {
	const method = req.method ?? "GET"
	if (method !== "GET" && method !== "HEAD") return false
	const page = rawPath === "/" && isAppClient(req) ? undefined : sitePages[rawPath]
	if (page) return sendSiteFile(req, res, join(siteDir, page))
	if (!rawPath.startsWith("/site/")) return false
	const candidate = resolve(join(siteDir, normalize(rawPath.slice("/site/".length))))
	if (candidate !== siteDir && !candidate.startsWith(siteDir + sep)) return false
	return sendSiteFile(req, res, candidate)
}
// <<< frontierx-landing

const listener = (req: IncomingMessage, res: ServerResponse): void => {
  applySecurityHeaders(req, res)
  const rawPath = (req.url ?? "/").split("?")[0]
  if (rawPath.startsWith("/releases/") && serveRelease(req, res, rawPath)) return
  if (serveSite(req, res, rawPath)) return
  if (serveStatic(req, res)) return
  app.listener(req, res)
}

// Disappearing messages: every minute, drop what has outlived the lifetime set
// for its conversation and tell the open clients so the bubbles vanish there
// too. Blobs of the attachments from that window go with them.
const TTL_SWEEP_MS = 60000
const sweepExpiredMessages = (): void => {
  const now = Date.now()
  for (const row of app.store.listConversationsWithTtl()) {
    const cutoff = new Date(now - row.ttlSeconds * 1000).toISOString()
    let purged
    try {
      purged = app.store.purgeExpiredMessages(row.id, cutoff)
    } catch (error) {
      console.error("[frontierx-api] ttl sweep failed", row.id, error)
      continue
    }
    if (purged.messageIds.length === 0 && purged.fileIds.length === 0) continue
    for (const fileId of purged.fileIds) {
      try {
        deleteBlob(fileId)
      } catch {
        // The blob may already be gone; the row is deleted either way.
      }
    }
    const members = app.store.listMembers(row.id).map((m) => m.userId)
    for (const messageId of purged.messageIds) {
      app.bus.publishToUsers(members, { type: "message.deleted", conversationId: row.id, messageId } as never)
    }
    console.log("[frontierx-api] ttl sweep", { conversationId: row.id, messages: purged.messageIds.length, files: purged.fileIds.length })
  }
}
const ttlTimer = setInterval(sweepExpiredMessages, TTL_SWEEP_MS)
ttlTimer.unref()

// "Last seen" heartbeat: if the process stops without disconnects, the time
// others see is at most a minute off.
// Scheduled messages go out within a couple of seconds of their time.
const scheduleTimer = setInterval(() => {
  try {
    app.deliverDueScheduled()
  } catch (error) {
    console.error("[frontierx-api] scheduled delivery failed", error)
  }
}, 2000)
scheduleTimer.unref()

// Bot updates nobody collected within a day are dropped.
const botPruneTimer = setInterval(() => {
  try {
    app.store.pruneBotUpdates(new Date(Date.now() - 24 * 3600 * 1000).toISOString())
  } catch (error) {
    console.error("[frontierx-api] bot update pruning failed", error)
  }
}, 3600000)
botPruneTimer.unref()

const seenTimer = setInterval(() => {
  try {
    app.refreshLastSeen()
  } catch (error) {
    console.error("[frontierx-api] last-seen heartbeat failed", error)
  }
}, 60000)
seenTimer.unref()
sweepExpiredMessages()

const server = createServer(listener)
// Node aborts any request that takes longer than five minutes by default,
// which silently killed large attachment uploads on slow uplinks. The header
// phase keeps its own (short) timeout, so a stalled connection is still cut.
server.requestTimeout = 0
server.headersTimeout = 60000
attachWebSocket(server, app)

server.listen(port, host, () => {
  console.log("[frontierx-api] listening", {
    host,
    port,
    dbPath,
    web: webEnabled ? webDir : "(static serving disabled)",
  })
})