# FrontierX - API

Stage-1 HTTP + WebSocket surface served by apps/api. All bodies are JSON. Message and file contents are ciphertext produced on the client; the server never sees plaintext.

## Authentication

Clients obtain a session token (POST /api/auth/login or /api/auth/register), then send it as a Bearer token on later requests. The server stores only a SHA-256 hash of the token; tokens expire after 30 days.

## HTTP endpoints

- GET /api/health - liveness. Returns { ok, service, protocol }.
- POST /api/auth/register - create an account. Body { username, password, displayName }. Returns { token, user }.
- POST /api/auth/login - Body { username, password }. Returns { token, user }.
- GET /api/me - the authenticated user. Returns { user }.
- POST /api/conversations - create a conversation. Body { kind, title, memberIds }. kind is direct | group | channel. Returns { conversation }.
- GET /api/conversations - conversations the caller belongs to. Returns { conversations }.
- GET /api/conversations/:id/messages - message history (ciphertext). Returns { messages }.
- POST /api/conversations/:id/messages - send a message. Body { ciphertext, replyTo? }. Returns { message } and fans out message.created over WebSocket.
- GET /api/conversations/:id/presence - member-scoped live WebSocket presence. Returns { onlineUserIds }. It is ephemeral and never exposes a global user roster.
- POST /api/conversations/:id/receipts - update read state. Body { messageId, state }. state is sent | delivered | read. Fans out receipt.updated.
- GET /api/conversations/:id/files - file assets in a conversation. Returns { files }, each item { asset, replica }.
- POST /api/files - register a file asset (metadata + encrypted manifest). Returns { asset, replica } with status 201.
- GET /api/files/:id - a single file asset with its replica.

File lifecycle transitions (each returns the updated replica and fans out file.state_changed):
- POST /api/files/:id/backup/begin - start uploading the encrypted backup (LOCAL_AVAILABLE -> BACKUP_UPLOADING)
- POST /api/files/:id/backup/complete - backup stored (-> TEMP_SERVER_BACKUP, sets a ~25-day expiry)
- POST /api/files/:id/backup/fail - upload failed (-> LOCAL_AVAILABLE)
- POST /api/files/:id/restore/begin - start restoring to a device (-> RESTORING)
- POST /api/files/:id/restore/complete - restore confirmed saved locally (-> LOCAL_AVAILABLE)
- POST /api/files/:id/lost - local copy lost (-> MISSING)

Errors use conventional status codes: 400 validation, 401 missing or invalid session, 403 not a member, 404 not found, 409 illegal lifecycle transition, 500 internal.

## WebSocket protocol

A client opens one authenticated WebSocket. The server first sends a ready acknowledgement, then pushes typed events (defined in packages/protocol/src/index.ts):

- ready - connection established.
- message.created - a new message envelope for a conversation the client is in.
- presence.updated - a member's live connection state changed; payload { conversationId, userId, online }. Events are fanned out only to members of that conversation.
- receipt.updated - a read or delivery receipt changed.
- file.state_changed - a file replica changed state; payload { fileAssetId, replicaId, state, tempExpiresAt }. The web FilePanel uses this to reflect backup and restore progress.

All event payloads carry ciphertext or metadata only.
