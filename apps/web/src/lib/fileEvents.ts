import type { Replica, WsEvent } from "./types"

export type FileStateEvent = Extract<WsEvent, { type: "file.state_changed" }>

// Merge a file.state_changed event into a list of file rows, returning a new array.
// The row whose asset id matches gets a freshly built Replica; other rows are
// returned unchanged. Pure and side-effect free so it can be unit tested.
export function applyFileStateEvent<Row extends { asset: { id: string }; replica: Replica | null }>(
	rows: Row[],
	event: FileStateEvent,
): Row[] {
	const replica: Replica = {
		id: event.replicaId,
		fileAssetId: event.fileAssetId,
		state: event.state,
		tempExpiresAt: event.tempExpiresAt,
	}
	return rows.map((row) => (row.asset.id === event.fileAssetId ? ({ ...row, replica } as Row) : row))
}
