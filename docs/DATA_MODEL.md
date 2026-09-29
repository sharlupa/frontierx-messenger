# FrontierX — Data Model

Identifiers are sortable generated IDs. Server timestamps are UTC ISO strings. This describes the current SQLite development model, not a promised production Postgres schema.

## Implemented core entities

- **User** — `id`, `username`, `password_hash`, `display_name`, `created_at`, optional `public_key`.
- **Session** — `id`, `token_hash`, `user_id`, `label`, `created_at`, `last_seen_at`, `expires_at`.
  - `token_hash` is the SHA-256 hash of a random bearer token; raw tokens are not stored.
  - `label` is a browser/user-agent label, not a cryptographic device identity.
- **Conversation** — `id`, `kind` (`direct`, `group`, `channel`), title, creator, creation time.
- **Membership** — conversation/user relationship, role (`owner`, `admin`, `member`, `restricted`), joined time, and personal archive state.
- **Message** — conversation, sender, ciphertext, reply reference, created time, edited/deleted timestamps.
- **Receipt** — message/user delivery or read state.
- **Pinned message** — durable conversation pin with actor/time metadata; pins are cleared when their message is deleted.
- **Conversation draft** — owner-scoped encrypted ciphertext and update time. The API never needs draft plaintext.
- **File asset and replica** — encrypted-file metadata, owner/context, replica lifecycle state, temporary expiry, and opaque backup relationship.

## Ephemeral presence

Presence is intentionally not a database entity. A user is online while at least one authenticated WebSocket subscription exists in the active API process; their final socket close emits an offline transition. The API returns and fans out this state only to existing conversation members. A process restart makes every user offline until their client reconnects.

## Session lifecycle

A login or registration creates a new independent browser session. Requests authenticate by comparing the bearer token hash. Expired sessions are deleted. A successful authenticated request refreshes `last_seen_at`. A holder can list only their own safe session projection:

```text
id, label, createdAt, lastSeenAt, expiresAt, current
```

The session endpoint never returns `token_hash` or a raw token. Deletion by session ID is owner-scoped; deleting the current session is allowed and the browser signs out.

## Conversation ownership and visibility

- Membership is required for protected conversation, message, file, draft, and pin access.
- Archive state and drafts are personal: one member's choice does not alter other members' visible state.
- Roles restrict mutation: restricted members are read-only; channels permit posting only to owners and administrators.

## File lifecycle

Logical file assets and replicas separate metadata from availability. Current replica states are:

```text
LOCAL_AVAILABLE
BACKUP_UPLOADING
TEMP_SERVER_BACKUP
RESTORING
MISSING
EXPIRED
PURGED
```

The backup is ciphertext-only. A restore validates the encrypted bundle and local save before the temporary server copy is removed.

## Not yet represented as production entities

There is no dedicated cryptographic `Device` table, device-verification state, prekey bundle, ratchet state, MLS group state, push subscription system, call record, Story, bot, Mini App, or production job/audit model. Those must be designed and delivered before their product capabilities can be claimed.
