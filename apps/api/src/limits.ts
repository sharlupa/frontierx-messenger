// Byte-size limits for FrontierX, expressed as explicit byte counts so the
// values are unambiguous. 2 GiB = 2147483648 bytes, 500 MiB = 524288000 bytes.
// Each can be overridden with an environment variable.

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// Maximum plaintext size of a single file a user may send to a chat (2 GiB).
export const MAX_FILE_BYTES = envBytes("FILE_MAX_BYTES", 2147483648)

// Encrypted backup bundles contain an authenticated manifest and per-chunk
// framing, so they are slightly larger than their source file. Keep a bounded
// allowance rather than treating a 2 GiB plaintext limit as a 2 GiB request
// body limit. Deployments with tight memory/disk budgets should set this
// explicitly alongside FILE_MAX_BYTES.
export const MAX_BLOB_BYTES = envBytes("FILE_BLOB_MAX_BYTES", MAX_FILE_BYTES + 1048576)

// Per-user quota for encrypted temp-server backups of files the user deleted
// locally, retained for FILE_RETENTION_DAYS (default 25 days). Default 2 GiB.
export const TEMP_BACKUP_QUOTA_BYTES = envBytes("TEMP_BACKUP_QUOTA_BYTES", 2147483648)

// Per-user quota for saved stickers and GIFs (stored in the database).
// Default 100 MiB = 104857600 bytes.
export const STICKER_GIF_QUOTA_BYTES = envBytes("STICKER_GIF_QUOTA_BYTES", 104857600)

// Total encrypted file bytes one user may keep on the server across all chats.
// Default 5 GiB = 5368709120 bytes.
export const USER_STORAGE_QUOTA_BYTES = envBytes("USER_STORAGE_QUOTA_BYTES", 5368709120)

// Uploads are refused once they would leave less than this much free space on
// the disk holding the blobs, so a flood of files cannot fill the machine and
// take down everything else running on it. Default 5 GiB.
export const DISK_RESERVE_BYTES = envBytes("DISK_RESERVE_BYTES", 5368709120)
