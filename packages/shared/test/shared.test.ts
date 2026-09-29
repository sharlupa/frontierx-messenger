import test from "node:test"
import assert from "node:assert/strict"
import { ManualClock, SystemClock } from "../src/clock"
import { ok, err, isOk, isErr } from "../src/result"
import { ulid, newId } from "../src/id"

test("ManualClock advances by days", () => {
  const c = new ManualClock(0)
  assert.equal(c.nowMs(), 0)
  c.advanceDays(2)
  assert.equal(c.nowMs(), 2 * 86400000)
})

test("SystemClock returns a positive time", () => {
  assert.ok(new SystemClock().nowMs() > 0)
})

test("Result helpers narrow correctly", () => {
  const a = ok(5)
  const b = err("bad")
  assert.ok(isOk(a) && a.value === 5)
  assert.ok(isErr(b) && b.error === "bad")
})

test("ulid is 26 chars, sortable, and prefixable", () => {
  const a = ulid(1000)
  const b = ulid(2000)
  assert.equal(a.length, 26)
  assert.ok(a < b)
  assert.ok(newId("msg").startsWith("msg_"))
})
