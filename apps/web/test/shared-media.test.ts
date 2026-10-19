import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyMessage, linksInText, type SharedContent } from "../src/lib/sharedMedia"
import { LINK_PREFIX } from "../src/lib/linkmsg"
import { MEDIA_PREFIX } from "../src/lib/media"

const empty = (): SharedContent => ({ media: [], files: [], links: [], gifs: [], complete: false })
const envelope = { id: "m1", senderId: "u1", createdAt: "2026-10-06T10:00:00.000Z" }
const manifest = { version: 1, chunkSize: 1, chunks: 1, size: 1 }
const mediaText = (fields: Record<string, unknown>) => MEDIA_PREFIX + JSON.stringify({ fileId: "f1", key: "k", size: 10, manifest, ...fields })

test("links are found in text, trimmed of punctuation, and spoilers stay hidden", () => {
	assert.deepEqual(linksInText("see https://example.com/a_b_c, and (https://ex.org/x)."), ["https://example.com/a_b_c", "https://ex.org/x"])
	assert.deepEqual(linksInText("wiki https://en.wikipedia.org/wiki/Foo_(bar) ok"), ["https://en.wikipedia.org/wiki/Foo_(bar)"])
	assert.deepEqual(linksInText("secret ||https://hidden.example|| shown http://open.example"), ["http://open.example/"])
	assert.deepEqual(linksInText("javascript:alert(1) ftp://x.y"), [])
})

test("messages sort into media, files, GIFs and links", () => {
	const out = empty()
	classifyMessage(out, envelope, mediaText({ kind: "image", name: "a.jpg", mime: "image/jpeg" }))
	classifyMessage(out, envelope, mediaText({ kind: "file", name: "clip.mp4", mime: "video/mp4" }))
	classifyMessage(out, envelope, mediaText({ kind: "file", name: "animation.mp4", mime: "video/mp4" }))
	classifyMessage(out, envelope, mediaText({ kind: "image", name: "x.gif", mime: "image/gif" }))
	classifyMessage(out, envelope, mediaText({ kind: "file", name: "report.pdf", mime: "application/pdf", caption: "read https://docs.example/r" }))
	classifyMessage(out, envelope, mediaText({ kind: "voice", name: "voice.ogg", mime: "audio/ogg" }))
	classifyMessage(out, envelope, LINK_PREFIX + JSON.stringify({ text: "look https://site.example/p", preview: { url: "https://site.example/p", title: "Site", description: null, siteName: "S", image: null } }))
	classifyMessage(out, envelope, "plain https://one.example and https://two.example")
	assert.deepEqual(out.media.map((item) => item.media.name), ["a.jpg", "clip.mp4"])
	assert.deepEqual(out.gifs.map((item) => item.media.name), ["animation.mp4", "x.gif"])
	assert.deepEqual(out.files.map((item) => item.media.name), ["report.pdf"])
	assert.deepEqual(out.links.map((link) => link.url), ["https://docs.example/r", "https://site.example/p", "https://one.example/", "https://two.example/"])
	assert.equal(out.links[1].title, "Site", "a preview card keeps its title and is not listed twice")
})
