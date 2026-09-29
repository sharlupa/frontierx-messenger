// Link previews are fetched by the sender's request and then travel inside the
// encrypted message, so the server never learns which links the recipients see.
// The fetch itself is the risky part: it must never be usable to reach the
// machine's own network, so addresses are resolved and checked before use and
// redirects are followed by hand.

import { assertPublicUrl, guardedRequest } from "./netguard.js"

export interface LinkPreview {
  url: string
  title: string | null
  description: string | null
  imageUrl: string | null
  siteName: string | null
}

const MAX_HTML_BYTES = 512 * 1024
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 6000
const MAX_REDIRECTS = 3
const USER_AGENT = "FrontierX-LinkPreview/1.0"

async function fetchChecked(target: string, accept: string, maxBytes: number, truncate = false): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
  let current = target
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = assertPublicUrl(current)
    const res = await guardedRequest(url, {
      headers: { accept, "user-agent": USER_AGENT, "accept-language": "ru,en;q=0.8" },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes,
      truncate,
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location
      if (!location) throw new Error("redirect without location")
      current = new URL(location, url).toString()
      continue
    }
    if (res.status < 200 || res.status >= 300) throw new Error("upstream status " + String(res.status))
    const contentType = res.headers["content-type"] ?? ""
    return { bytes: new Uint8Array(res.body), contentType, finalUrl: url.toString() }
  }
  throw new Error("too many redirects")
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const pattern = new RegExp(
      "<meta[^>]+(?:property|name)\\s*=\\s*[\"']" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"'][^>]*>",
      "i",
    )
    const tag = html.match(pattern)
    if (!tag) continue
    const content = tag[0].match(/content\s*=\s*["']([^"']*)["']/i)
    if (content && content[1].trim()) return decodeEntities(content[1].trim())
  }
  return null
}

function clamp(value: string | null, limit: number): string | null {
  if (!value) return null
  const trimmed = value.replace(/\s+/g, " ").trim()
  if (!trimmed) return null
  return trimmed.length > limit ? trimmed.slice(0, limit) + "…" : trimmed
}

export async function buildLinkPreview(raw: string): Promise<LinkPreview> {
  const { bytes, contentType, finalUrl } = await fetchChecked(raw, "text/html,application/xhtml+xml", MAX_HTML_BYTES, true)
  if (contentType && contentType.indexOf("html") < 0) throw new Error("not an html page")
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  const head = html.slice(0, MAX_HTML_BYTES)
  const titleTag = head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  const title = clamp(metaContent(head, ["og:title", "twitter:title"]) ?? (titleTag ? decodeEntities(titleTag[1]) : null), 140)
  const description = clamp(metaContent(head, ["og:description", "twitter:description", "description"]), 220)
  const rawImage = metaContent(head, ["og:image", "og:image:url", "twitter:image"])
  let imageUrl: string | null = null
  if (rawImage) {
    try {
      imageUrl = new URL(rawImage, finalUrl).toString()
    } catch {
      imageUrl = null
    }
  }
  const siteName = clamp(metaContent(head, ["og:site_name"]) ?? new URL(finalUrl).hostname, 60)
  return { url: finalUrl, title, description, imageUrl, siteName }
}

// The preview image is proxied so the sender's browser can shrink it into the
// message; recipients then never touch the remote site at all.
export async function fetchPreviewImage(raw: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { bytes, contentType } = await fetchChecked(raw, "image/*", MAX_IMAGE_BYTES)
  if (contentType && contentType.indexOf("image/") !== 0) throw new Error("not an image")
  return { bytes, contentType: contentType || "image/jpeg" }
}
