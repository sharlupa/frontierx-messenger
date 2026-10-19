import { test } from "node:test"
import assert from "node:assert/strict"
import { EMOJI_NAMES } from "../src/lib/emojiNames"
import { EMOJI_DATA } from "../src/lib/emojiData"
import { searchEmoji } from "../src/lib/emojiSearch"
import { formatBytes } from "../src/lib/i18n"
import { micProblemOf } from "../src/lib/webrtc"

test("every emoji of the panel can be found by name", () => {
  for (const group of EMOJI_DATA) for (const emoji of group.emoji) assert.ok(EMOJI_NAMES[emoji], "no name for " + emoji)
})

test("emoji search understands English and Russian, all words must match", () => {
  assert.ok(searchEmoji("сердце", EMOJI_NAMES).includes("❤️"))
  assert.ok(searchEmoji("heart", EMOJI_NAMES).includes("❤️"))
  assert.ok(searchEmoji("Смешно", EMOJI_NAMES).includes("😂"), "case does not matter")
  assert.ok(searchEmoji("флаг россия", EMOJI_NAMES).includes("🇷🇺"))
  assert.deepEqual(searchEmoji("   ", EMOJI_NAMES), [])
  assert.deepEqual(searchEmoji("qqqzzzxxx", EMOJI_NAMES), [])
  const thumbs = searchEmoji("лайк", EMOJI_NAMES)
  assert.equal(thumbs[0], "👍", "a name that starts with the query comes first")
})

test("sizes are written in the units of the language", () => {
  assert.equal(formatBytes("en", 2 * 1024 * 1024), "2 MB")
  assert.equal(formatBytes("ru", 2 * 1024 * 1024), "2 МБ")
  assert.equal(formatBytes("en", 1024 * 1024 * 1024), "1 GB")
  assert.equal(formatBytes("ru", 1536), "1,5 кБ")
  assert.equal(formatBytes("en", 512), "512B")
  assert.equal(formatBytes("en", -1), "")
})

test("microphone errors map to what the person can do about them", () => {
  const err = (name: string) => Object.assign(new Error(name), { name })
  assert.equal(micProblemOf(err("NotAllowedError")), "denied")
  assert.equal(micProblemOf(err("NotFoundError")), "missing")
  assert.equal(micProblemOf(err("NotReadableError")), "busy")
  assert.equal(micProblemOf(err("TypeError")), "unknown")
  assert.equal(micProblemOf(null), "unknown")
})
