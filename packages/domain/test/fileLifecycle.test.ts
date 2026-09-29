import test from "node:test"
import assert from "node:assert/strict"
import { FileLifecycle } from "../src/fileLifecycle"
import type { NotificationSink } from "../src/fileLifecycle"

// Local test doubles keep this unit test free of cross-package runtime imports.
class TestClock {
  t: number
  constructor(start = 0) {
    this.t = start
  }
  now(): Date {
    return new Date(this.t)
  }
  nowMs(): number {
    return this.t
  }
  advanceDays(d: number): void {
    this.t += d * 86400000
  }
}

class MemSink implements NotificationSink {
  private done = new Set<string>()
  events: Array<{ id: string; kind: string }> = []
  hasNotified(id: string, kind: string): boolean {
    return this.done.has(`${id}:${kind}`)
  }
  markNotified(id: string, kind: string): void {
    this.done.add(`${id}:${kind}`)
  }
  notify(id: string, kind: string): void {
    this.events.push({ id, kind })
  }
}

function setup() {
  const clock = new TestClock(0)
  const lc = new FileLifecycle(clock)
  const r = lc.create("rep_1", "file_1")
  return { clock, lc, r }
}

test("remove-local moves to uploading, backup only after verified upload", () => {
  const { lc, r } = setup()
  assert.equal(r.state, "LOCAL_AVAILABLE")
  lc.beginRemoveLocalCopy(r)
  assert.equal(r.state, "BACKUP_UPLOADING")
  lc.completeUpload(r)
  assert.equal(r.state, "TEMP_SERVER_BACKUP")
  assert.equal(r.tempExpiresAt, 25 * 86400000)
})

test("failed upload keeps the local copy", () => {
  const { lc, r } = setup()
  lc.beginRemoveLocalCopy(r)
  lc.failUpload(r)
  assert.equal(r.state, "LOCAL_AVAILABLE")
})

test("illegal transitions throw", () => {
  const { lc, r } = setup()
  assert.throws(() => lc.completeUpload(r))
  assert.throws(() => lc.purge(r))
})

test("day-20 warning fires exactly once (idempotent)", () => {
  const { clock, lc, r } = setup()
  lc.beginRemoveLocalCopy(r)
  lc.completeUpload(r)
  const sink = new MemSink()
  clock.advanceDays(19)
  assert.deepEqual(lc.tick([r], sink).notified, [])
  clock.advanceDays(1)
  assert.deepEqual(lc.tick([r], sink).notified, ["rep_1"])
  clock.advanceDays(1)
  assert.deepEqual(lc.tick([r], sink).notified, [])
  assert.equal(sink.events.filter((e) => e.kind === "expiry_warning").length, 1)
})

test("day-25 expiry then purge", () => {
  const { clock, lc, r } = setup()
  lc.beginRemoveLocalCopy(r)
  lc.completeUpload(r)
  clock.advanceDays(25)
  assert.deepEqual(lc.tick([r], new MemSink()).expired, ["rep_1"])
  assert.equal(r.state, "EXPIRED")
  lc.purge(r)
  assert.equal(r.state, "PURGED")
  assert.equal(r.tempExpiresAt, null)
})

test("restore before expiry returns to local and clears the timer", () => {
  const { clock, lc, r } = setup()
  lc.beginRemoveLocalCopy(r)
  lc.completeUpload(r)
  clock.advanceDays(10)
  lc.beginRestore(r)
  assert.equal(r.state, "RESTORING")
  lc.completeRestore(r)
  assert.equal(r.state, "LOCAL_AVAILABLE")
  assert.equal(r.tempExpiresAt, null)
})

test("restore/expiry race is safe: restoring is never expired", () => {
  const { clock, lc, r } = setup()
  lc.beginRemoveLocalCopy(r)
  lc.completeUpload(r)
  clock.advanceDays(24)
  lc.beginRestore(r)
  clock.advanceDays(5)
  assert.deepEqual(lc.tick([r], new MemSink()).expired, [])
  assert.equal(r.state, "RESTORING")
  lc.completeRestore(r)
  assert.equal(r.state, "LOCAL_AVAILABLE")
})

test("MISSING local with a valid backup can begin restore", () => {
  const { lc, r } = setup()
  lc.markLocalLost(r)
  assert.equal(r.state, "MISSING")
  lc.beginRestore(r)
  assert.equal(r.state, "RESTORING")
})

test("expired backups cannot be restored", () => {
  const { clock, lc, r } = setup()
  lc.beginRemoveLocalCopy(r)
  lc.completeUpload(r)
  clock.advanceDays(25)
  lc.tick([r], new MemSink())
  assert.equal(r.state, "EXPIRED")
  assert.throws(() => lc.beginRestore(r))
})
