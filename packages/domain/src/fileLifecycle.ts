import type { Clock } from "@frontierx/shared"
import type { ReplicaState } from "@frontierx/protocol"

// Pure, framework-free file-lifecycle state machine. All time comes from an
// injected Clock so the 20/25-day behavior is deterministic under test.
// See docs/FILE_LIFECYCLE.md for the state chart and safety rules.

const DAY_MS = 24 * 60 * 60 * 1000

export interface ReplicaRecord {
  id: string
  fileAssetId: string
  state: ReplicaState
  tempExpiresAt: number | null // epoch ms
  updatedAt: number
}

export interface LifecyclePolicy {
  retentionDays: number
  notifyOnDay: number
}

export const DEFAULT_POLICY: LifecyclePolicy = { retentionDays: 25, notifyOnDay: 20 }

export interface NotificationSink {
  hasNotified(replicaId: string, kind: string): boolean
  markNotified(replicaId: string, kind: string): void
  notify(replicaId: string, kind: string, payload: Record<string, unknown>): void
}

export class LifecycleError extends Error {}

export class FileLifecycle {
  constructor(
    private readonly clock: Clock,
    private readonly policy: LifecyclePolicy = DEFAULT_POLICY,
  ) {}

  create(id: string, fileAssetId: string): ReplicaRecord {
    return {
      id,
      fileAssetId,
      state: "LOCAL_AVAILABLE",
      tempExpiresAt: null,
      updatedAt: this.clock.nowMs(),
    }
  }

  private touch(r: ReplicaRecord, state: ReplicaState): ReplicaRecord {
    r.state = state
    r.updatedAt = this.clock.nowMs()
    return r
  }

  /** User chose to remove the local copy: begin uploading the encrypted backup. */
  beginRemoveLocalCopy(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "LOCAL_AVAILABLE")
      throw new LifecycleError(`cannot remove local copy from ${r.state}`)
    return this.touch(r, "BACKUP_UPLOADING")
  }

  /** Upload verified (manifest + every chunk tag): now safe to drop the local copy. */
  completeUpload(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "BACKUP_UPLOADING")
      throw new LifecycleError(`cannot complete upload from ${r.state}`)
    r.tempExpiresAt = this.clock.nowMs() + this.policy.retentionDays * DAY_MS
    return this.touch(r, "TEMP_SERVER_BACKUP")
  }

  /** Upload failed: keep the local copy, no data loss. */
  failUpload(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "BACKUP_UPLOADING")
      throw new LifecycleError(`cannot fail upload from ${r.state}`)
    return this.touch(r, "LOCAL_AVAILABLE")
  }

  beginRestore(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "TEMP_SERVER_BACKUP" && r.state !== "MISSING")
      throw new LifecycleError(`cannot restore from ${r.state}`)
    return this.touch(r, "RESTORING")
  }

  /** Restore verified locally: server backup is no longer needed. */
  completeRestore(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "RESTORING")
      throw new LifecycleError(`cannot complete restore from ${r.state}`)
    r.tempExpiresAt = null
    return this.touch(r, "LOCAL_AVAILABLE")
  }

  /** Restore failed: the backup is still intact (or already expired). */
  failRestore(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "RESTORING")
      throw new LifecycleError(`cannot fail restore from ${r.state}`)
    const stillValid = r.tempExpiresAt != null && r.tempExpiresAt > this.clock.nowMs()
    return this.touch(r, stillValid ? "TEMP_SERVER_BACKUP" : "EXPIRED")
  }

  markLocalLost(r: ReplicaRecord): ReplicaRecord {
    if (r.state === "LOCAL_AVAILABLE") return this.touch(r, "MISSING")
    return r
  }

  /**
   * Worker tick: fire the day-N warning once (idempotent via the sink) and
   * expire backups whose retention has elapsed. A record being RESTORING is
   * never expired, which makes the restore/expiry race safe.
   */
  tick(
    records: ReplicaRecord[],
    sink: NotificationSink,
  ): { notified: string[]; expired: string[] } {
    const now = this.clock.nowMs()
    const notified: string[] = []
    const expired: string[] = []
    const warnLeadDays = this.policy.retentionDays - this.policy.notifyOnDay
    for (const r of records) {
      if (r.state !== "TEMP_SERVER_BACKUP" || r.tempExpiresAt == null) continue
      const notifyAt = r.tempExpiresAt - warnLeadDays * DAY_MS
      if (now >= notifyAt && !sink.hasNotified(r.id, "expiry_warning")) {
        sink.markNotified(r.id, "expiry_warning")
        sink.notify(r.id, "expiry_warning", { tempExpiresAt: r.tempExpiresAt })
        notified.push(r.id)
      }
      if (now >= r.tempExpiresAt) {
        this.touch(r, "EXPIRED")
        expired.push(r.id)
      }
    }
    return { notified, expired }
  }

  purge(r: ReplicaRecord): ReplicaRecord {
    if (r.state !== "EXPIRED") throw new LifecycleError(`cannot purge from ${r.state}`)
    r.tempExpiresAt = null
    return this.touch(r, "PURGED")
  }
}
