import { test } from "node:test"
import assert from "node:assert/strict"
import { badgeLabel } from "../src/lib/tabBadge"

test("the tab badge shows the count, capped at 99+", () => {
	assert.equal(badgeLabel(0), "")
	assert.equal(badgeLabel(-2), "")
	assert.equal(badgeLabel(7), "7")
	assert.equal(badgeLabel(99), "99")
	assert.equal(badgeLabel(140), "99+")
})
