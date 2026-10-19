import { test } from "node:test"
import assert from "node:assert/strict"
import { ALBUM_MAX_ITEMS, albumOf, albumRows, chunkIntoAlbums, groupAlbums } from "../src/lib/album"
import type { DisplayMessage } from "../src/lib/types"
import type { MediaEnvelope } from "../src/lib/media"

const media = (album?: { id: string; index: number; count: number }) => ({ kind: "image", fileId: "f", name: "p.jpg", mime: "image/jpeg", size: 1, key: "k", manifest: {}, ...(album ? { album } : {}) }) as unknown as MediaEnvelope
const msg = (id: string, sender: string, album?: { id: string; index: number; count: number }, extra: Partial<DisplayMessage> = {}): DisplayMessage => ({ id, conversationId: "c", senderId: sender, createdAt: "2026-10-14T00:00:00Z", text: null, locked: false, media: media(album), ...extra })

test("pictures are split into albums of nine at most, a single one is a plain message", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => i)
  const chunks = chunkIntoAlbums(twenty)
  assert.deepEqual(chunks.map((c) => c.items.length), [9, 9, 2])
  assert.ok(chunks.every((c) => c.album))
  assert.notEqual(chunks[0].album?.id, chunks[1].album?.id)
  assert.equal(chunkIntoAlbums([1])[0].album, null)
  assert.deepEqual(chunkIntoAlbums(Array.from({ length: 10 }, (_, i) => i)).map((c) => [c.items.length, Boolean(c.album)]), [[9, true], [1, false]])
  assert.equal(ALBUM_MAX_ITEMS, 9)
})

test("album marks from a sender are checked", () => {
  assert.deepEqual(albumOf(media({ id: "a", index: 1, count: 3 })), { id: "a", index: 1, count: 3 })
  assert.equal(albumOf(media({ id: "a", index: 3, count: 3 })), null)
  assert.equal(albumOf(media({ id: "a", index: 0, count: 40 })), null)
  assert.equal(albumOf(media({ id: "", index: 0, count: 2 })), null)
  assert.equal(albumOf(media()), null)
})

test("consecutive messages of one album are drawn together", () => {
  const units = groupAlbums([
    msg("1", "u", { id: "A", index: 0, count: 3 }),
    msg("2", "u", { id: "A", index: 1, count: 3 }),
    msg("3", "u", { id: "A", index: 2, count: 3 }),
    msg("4", "u", { id: "B", index: 0, count: 2 }),
    msg("5", "v"),
    msg("6", "u", { id: "B", index: 1, count: 2 }),
    msg("7", "u", { id: "C", index: 0, count: 2 }),
    msg("8", "u", { id: "C", index: 1, count: 2 }, { deleted: true }),
  ])
  assert.deepEqual(units.map((u) => u.members.map((m) => m.id).join("+")), ["1+2+3", "4", "5", "6", "7", "8"])
})

test("every album size has a grid", () => {
  for (let n = 1; n <= ALBUM_MAX_ITEMS; n++) assert.equal(albumRows(n).reduce((a, b) => a + b, 0), n)
})
