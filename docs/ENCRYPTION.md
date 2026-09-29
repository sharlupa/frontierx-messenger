# FrontierX — encryption and keys

Everything below runs in the client (WebCrypto); the server stores and relays
sealed data only. Source: `apps/web/src/lib/keyvault.ts`, `keyring.ts`,
`accountKeys.ts`; server side: `apps/api/src/keysv2.ts`.

## Account key

- 32 random bytes per account (AK). It never leaves a device unsealed.
- **Slots** seal the AK for the ways back into an account:
  - password — PBKDF2-SHA256, 600 000 iterations, NFKC-normalised password;
  - recovery key — 20 random bytes shown as Crockford base32 with a checksum, HKDF-SHA256;
  - identity — ECIES over P-256 for a device's identity key;
  - device link — a one-time ECDH key, confirmed by a 16-digit code shown on both screens.
- A password reset by e-mail marks the password slot stale instead of deleting
  it: the previous password still opens the keys and they are then re-sealed.
- A check value (AES-GCM under the AK) lets a device verify it holds the right key.

## Vault

Identity keys and every conversation key a person holds are sealed with the AK
(AES-256-GCM, additional data binds each item to its account, conversation and
key id) and stored write-once on the server. A new device that unlocks the AK
gets its whole history back.

## Conversation keys

- Versioned: each key has an id (`k_…`); the first key of chats from the first
  key system is `legacy`. Keys are never deleted, so old messages stay readable.
- A new key is created by compare-and-set against the current one; the server
  refuses messages sealed with a key that is not current (409), and the client
  re-seals. When someone leaves a group, the next message goes out under a new key.
- Copies for members ("shares"): ECDH P-256 with a fresh key, HKDF-SHA256,
  AES-256-GCM; a published check value lets members verify they received the
  same key as everyone else.

## Messages and files

- Messages: `fx2:<keyId>:<base64(iv ‖ ciphertext)>`, AES-256-GCM with additional
  data `fx2|<conversationId>|<keyId>`.
- Files: a fresh 256-bit key per file, chunks sealed with AES-256-GCM
  (additional data `<fileId>:<chunk>`), a SHA-256 manifest; the file key travels
  inside the encrypted message. File names and types are sealed too.
- Location, contacts, polls, link previews and bot buttons are JSON inside the
  encrypted message body.

## What the server sees

Accounts (username, display name, optional e-mail), who is in which chat,
message timestamps and sizes, sealed blobs. It cannot read messages, files,
file names, keys or what a bot button carried.
