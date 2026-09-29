// Outbound requests on behalf of users (link previews, push delivery) must
// never reach this machine or its private network: the box also runs admin
// endpoints on loopback and other services on its public address. Checking a
// hostname once and then letting fetch() resolve it again is not enough, since
// a DNS answer can change between the two lookups (DNS rebinding). Here the
// address is checked inside the socket's own lookup, so the IP that gets
// connected to is exactly the IP that was checked.

import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import http from "node:http"
import https from "node:https"
import { BlockList, isIP } from "node:net"
import { networkInterfaces } from "node:os"

const blocked = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4")
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 and 6to4 forms can smuggle any IPv4 address. IPv4-mapped ones
  // (::ffff:a.b.c.d) need no rule: BlockList checks them against the IPv4
  // rules above, and a ::ffff:0:0/96 rule would match every IPv4 address.
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6")
}
// The machine's own addresses, including its public one: services listening
// there are not meant to be reachable through the API.
for (const list of Object.values(networkInterfaces())) {
  for (const entry of list ?? []) {
    blocked.addAddress(entry.address.split("%")[0], entry.family === "IPv6" ? "ipv6" : "ipv4")
  }
}
for (const value of String(process.env.OUTBOUND_DENY_IPS ?? "").split(",")) {
  const address = value.trim()
  const family = isIP(address)
  if (family) blocked.addAddress(address, family === 6 ? "ipv6" : "ipv4")
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return !blocked.check(address, family === 6 ? "ipv6" : "ipv4")
}

export class OutboundBlockedError extends Error {
  constructor(message = "address not allowed") {
    super(message)
    this.name = "OutboundBlockedError"
  }
}

// Syntactic checks that need no DNS. The resolved address is checked later, at
// connect time, by guardedLookup.
export function assertPublicUrl(raw: string, options: { httpsOnly?: boolean } = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundBlockedError("invalid url")
  }
  const allowed = options.httpsOnly ? ["https:"] : ["http:", "https:"]
  if (!allowed.includes(url.protocol)) throw new OutboundBlockedError("unsupported protocol")
  if (url.username || url.password) throw new OutboundBlockedError("credentials in url are not allowed")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host) throw new OutboundBlockedError("invalid url")
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new OutboundBlockedError()
    return url
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new OutboundBlockedError()
  }
  return url
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

function guardedLookup(hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true } as never, (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
    if (err) return callback(err, [])
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      return callback(new OutboundBlockedError() as NodeJS.ErrnoException, [])
    }
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

export interface GuardedResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super("response too large")
    this.name = "ResponseTooLargeError"
  }
}

// One request, no redirects followed (callers decide), body capped at maxBytes.
// With truncate the first maxBytes are returned instead of failing, which is
// all an HTML head needs.
export function guardedRequest(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs: number; maxBytes: number; truncate?: boolean },
): Promise<GuardedResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http
    const req = transport.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.body !== undefined ? { ...options.headers, "content-length": String(Buffer.byteLength(options.body)) } : options.headers,
        lookup: guardedLookup as never,
        timeout: options.timeoutMs,
      },
      (res) => {
        const declared = Number(res.headers["content-length"] ?? 0)
        if (!options.truncate && Number.isFinite(declared) && declared > options.maxBytes) {
          res.destroy()
          reject(new ResponseTooLargeError())
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on("data", (chunk: Buffer) => {
          if (total + chunk.length > options.maxBytes) {
            res.destroy()
            if (!options.truncate) {
              reject(new ResponseTooLargeError())
              return
            }
            chunks.push(chunk.subarray(0, options.maxBytes - total))
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
            return
          }
          total += chunk.length
          chunks.push(chunk)
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on("error", reject)
      },
    )
    // Overall deadline as well as the idle timeout, so a slow drip cannot hold
    // the request open indefinitely.
    const deadline = setTimeout(() => req.destroy(new Error("request timed out")), options.timeoutMs)
    req.on("close", () => clearTimeout(deadline))
    req.on("timeout", () => req.destroy(new Error("request timed out")))
    req.on("error", reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}
