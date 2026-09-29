import { test } from "node:test"
import assert from "node:assert/strict"
import { formatLastSeen, formatTimeOfDay } from "../src/lib/i18n"

// Local-time dates, so the checks hold in any time zone.
const now = new Date(2026, 8, 26, 15, 0, 0).getTime()
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString()

test("English uses a 12-hour clock without a leading zero, Russian 24-hour", () => {
	assert.equal(formatTimeOfDay("en", at(2026, 8, 26, 9, 5)), "9:05 AM")
	assert.equal(formatTimeOfDay("en", at(2026, 8, 26, 14, 5)), "2:05 PM")
	assert.equal(formatTimeOfDay("ru", at(2026, 8, 26, 9, 5)), "09:05")
})

test("last seen reads naturally in both languages", () => {
	assert.equal(formatLastSeen("en", new Date(now - 20000).toISOString(), now), "last seen just now")
	assert.equal(formatLastSeen("en", new Date(now - 60000).toISOString(), now), "last seen 1 minute ago")
	assert.equal(formatLastSeen("en", new Date(now - 5 * 60000).toISOString(), now), "last seen 5 minutes ago")
	assert.equal(formatLastSeen("en", at(2026, 8, 26, 9, 5), now), "last seen today at 9:05 AM")
	assert.equal(formatLastSeen("en", at(2026, 8, 25, 21, 10), now), "last seen yesterday at 9:10 PM")
	assert.equal(formatLastSeen("en", at(2026, 8, 12, 9, 30), now), "last seen Sep 12 at 9:30 AM")
	assert.equal(formatLastSeen("en", at(2025, 8, 12, 9, 30), now), "last seen Sep 12, 2025")

	assert.equal(formatLastSeen("ru", new Date(now - 1 * 60000).toISOString(), now), "был(а) в сети 1 минуту назад")
	assert.equal(formatLastSeen("ru", new Date(now - 3 * 60000).toISOString(), now), "был(а) в сети 3 минуты назад")
	assert.equal(formatLastSeen("ru", new Date(now - 11 * 60000).toISOString(), now), "был(а) в сети 11 минут назад")
	assert.equal(formatLastSeen("ru", new Date(now - 21 * 60000).toISOString(), now), "был(а) в сети 21 минуту назад")
	assert.equal(formatLastSeen("ru", at(2026, 8, 26, 9, 5), now), "был(а) в сети сегодня в 09:05")
	assert.equal(formatLastSeen("ru", at(2026, 8, 25, 21, 10), now), "был(а) в сети вчера в 21:10")
	assert.equal(formatLastSeen("ru", at(2026, 8, 12, 9, 30), now), "был(а) в сети 12 сентября в 09:30")
	assert.equal(formatLastSeen("ru", at(2025, 8, 12, 9, 30), now), "был(а) в сети 12 сентября 2025 г.")
})
