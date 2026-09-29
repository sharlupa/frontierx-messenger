import { test } from "node:test"
import assert from "node:assert/strict"
import { applyFileStateEvent } from "../src/lib/fileEvents"
import type { FileStateEvent } from "../src/lib/fileEvents"
import type { FileAsset, Replica } from "../src/lib/types"

type Row = { asset: FileAsset; replica: Replica | null }

function asset(id: string): FileAsset {
	return { id, conversationId: "c1", name: id + ".bin", mime: "application/octet-stream", size: 10, createdBy: "u1", createdAt: "2026-01-01T00:00:00Z" }
}

function makeRows(): Row[] {
	return [
		{ asset: asset("a1"), replica: null },
		{ asset: asset("a2"), replica: null },
	]
}

test("applyFileStateEvent updates only the matching row and builds a full replica", () => {
	const rows = makeRows()
	const event: FileStateEvent = { type: "file.state_changed", fileAssetId: "a1", replicaId: "r1", state: "TEMP_SERVER_BACKUP", tempExpiresAt: "2026-06-01T00:00:00Z" }
	const next = applyFileStateEvent(rows, event)
	assert.equal(next[0].replica?.id, "r1")
	assert.equal(next[0].replica?.state, "TEMP_SERVER_BACKUP")
	assert.equal(next[0].replica?.fileAssetId, "a1")
	assert.equal(next[0].replica?.tempExpiresAt, "2026-06-01T00:00:00Z")
	assert.equal(next[1].replica, null)
	assert.equal(rows[0].replica, null)
	assert.notEqual(next, rows)
})

test("applyFileStateEvent returns rows unchanged when no asset id matches", () => {
	const rows = makeRows()
	const event: FileStateEvent = { type: "file.state_changed", fileAssetId: "nope", replicaId: "r9", state: "MISSING", tempExpiresAt: null }
	const next = applyFileStateEvent(rows, event)
	assert.equal(next[0].replica, null)
	assert.equal(next[1].replica, null)
})
