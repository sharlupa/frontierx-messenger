import { test } from "node:test"
import assert from "node:assert/strict"
import { latestEntryOf } from "../src/lib/appUpdate"

test("the build's entry script is read from the served page", () => {
	const html = '<script type="module" crossorigin src="/assets/index-BNBwqJBp.js"></script><link rel="stylesheet" href="/assets/index-DyJoEbZr.css">'
	assert.equal(latestEntryOf(html), "/assets/index-BNBwqJBp.js")
	assert.equal(latestEntryOf("<html><body>landing</body></html>"), null)
})
