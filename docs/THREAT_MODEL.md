# FrontierX - Threat Model

Scope: the stage-1 foundation (web client + API + core messaging + local-first files). This document states what FrontierX protects, against whom, how, and what is explicitly not yet protected.

## Assets

- Message contents and file contents (highest value).
- Encryption keys (must never reach the server).
- Account credentials and session tokens.
- Metadata: who talks to whom, when, and how much (partially exposed - see gaps).

## Adversaries

- A network attacker between client and server.
- A curious or compromised server operator with database access.
- A thief who obtains a lost or backed-up device, or the temp server backup.

## Protections in place

- End-to-end encryption. Message bodies are encrypted client-side with AES-256-GCM (WebCrypto). A per-conversation key is derived with PBKDF2-SHA-256 (210,000 iterations, per-conversation salt) from a shared passphrase and bound to the conversation id; each message uses a fresh 12-byte IV inside an fx1 envelope. The server stores ciphertext only.
- Encrypted files. In the web client, file bytes are chunked and encrypted per chunk with AES-256-GCM (WebCrypto); each chunk's nonce is bound to the file id and chunk index, and a manifest records per-chunk and whole-file hashes for integrity. The shared Node crypto library (packages/crypto) implements the same authenticated-chunk scheme with ChaCha20-Poly1305. Keys never leave the device.
- Local-first storage. Files live on the device. Any server-side copy is an encrypted, time-boxed backup (default 25 days, notification on day 20); restore requires the user to confirm the bytes are saved locally again before the temp backup is released.
- Password storage. Passwords are hashed with scrypt (N=32768, r=8, p=1) in a labelled, parameterized format; verification is constant-time.
- Sessions. Tokens are 256-bit random values; only their SHA-256 hash is stored, so a database leak does not reveal usable tokens. Tokens expire after 30 days.
- Transport. TLS 1.3 is assumed in front of the API in any real deployment (terminated at the reverse proxy or load balancer).

## Known gaps (not yet protected)

- Key agreement. The current message key comes from a shared passphrase, not per-user key agreement. There is no forward secrecy and no protection against a malicious server substituting keys. An X3DH/MLS (libsignal-class) upgrade is planned; the fx1 envelope and labelled KDF format are versioned to allow migration.
- Metadata. The server observes conversation membership, message timing, sizes, and receipts. Metadata-minimizing techniques are future work.
- Password KDF. scrypt is solid, but Argon2id is the planned target; the labelled hash format allows a transparent upgrade.
- At-rest server storage. The dev store is SQLite; production Postgres and encrypted blob storage (S3 or MinIO) are scaffolded but not yet wired.
- Clients. Only the web client exists; desktop (Tauri) and Android (Kotlin) are planned.

This model will tighten as key agreement, durable storage, and the additional clients land.
