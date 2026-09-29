# Lean Debian 12 deployment profile

> **Planning and templates only.** Nothing in this directory has been executed
> on a VPS. It does not use `sudo`, change firewall rules, provision a user,
> install Caddy/Node, obtain TLS certificates, or deploy FrontierX. Review each
> operating-system action before running it on the server.

This profile is intentionally small for the agreed initial target:

- Debian 12 minimal, x86_64;
- 2 vCPU, 2 GiB RAM, 30 GiB NVMe, 1 Gbps networking;
- roughly ten concurrent users in an early/private deployment.

It is not a production-readiness claim and does not replace a security review,
backup/recovery test, staging run, or load test.

## Runtime topology

```text
Browser / PWA
    │ HTTPS + WebSocket
    ▼
Caddy: static web build + reverse proxy
    │ loopback only
    ▼
one Node API/WebSocket process
    ├── SQLite: /var/lib/frontierx/frontierx.db
    └── encrypted blobs: /var/lib/frontierx/blobs
```

There is no Vite dev server, Chromium, CI worker, server-side media
transcoding, OCR/ML worker, Docker stack, PostgreSQL, Redis, MinIO, Kafka, or
Kubernetes in this profile.

## Deliberate scope boundary

Video calls, screen sharing, recordings, transcription, and media processing
stay disabled. Voice calls (1:1 and group audio rooms) are the planned call
capability and still need a separate signaling/media-security implementation and
review before they are enabled. Do **not** install coturn
or expose TURN ports as part of this profile without explicit administrator
approval.

The current message/file E2EE design must not be used to imply that future call
media has been made E2EE; that requires its own implementation and verification.

## Release bundle

Build on a builder or CI machine with sufficient memory, not on the 2 GiB VPS:

```text
npm run build
npm run package:lean
```

`package:lean` creates the ignored `release/` directory from the verified build.
It contains the compiled API, static web output, and only the four compiled
`@frontierx/*` runtime packages that the API imports. It does **not** copy the
source tree, Vite, TypeScript, test tooling, Chromium, or the full development
`node_modules` directory. The script validates its required build inputs and
only permits output directory names `release` or `release-*`.

Before shipping a release, start its exact API entry on the builder with a
throwaway `DB_PATH` and `FILE_BLOB_DIR`, then check `GET /api/health`. This
validates the same plain Node ESM runtime that systemd will use. No experimental
specifier-resolution flag or TypeScript runtime loader is required.

## Required server layout

The systemd template expects the **contents** of `release/` at
`/srv/frontierx/current`, with durable data outside that replaceable directory:

```text
/srv/frontierx/current/
  apps/api/package.json
  apps/api/dist/apps/api/src/server.js  compiled API entry point
  apps/web/dist/                        static frontend build
  node_modules/@frontierx/*/dist/       minimal compiled runtime packages
  RELEASE-MANIFEST.json

/var/lib/frontierx/frontierx.db          durable SQLite database
/var/lib/frontierx/blobs/                durable encrypted file blobs
/etc/frontierx/api.env                   private environment file
```

The API build's nested `dist/apps/api/src/server.js` path is intentional: its
TypeScript configuration compiles the workspace source tree together. The
release includes `apps/api/package.json` so Node treats that entry as ESM.

Do not run `vite`, the test suite, browser QA, or a package installation on the
2 GiB VPS. The bundle is self-contained for the API's current all-internal
runtime dependencies; build and package it elsewhere first.

## Templates in this directory

- `api.env.example` — values for `/etc/frontierx/api.env`.
- `frontierx-api.service` — a bounded, loopback-only systemd service template.
- `Caddyfile` — HTTPS/static frontend/API/WebSocket reverse-proxy template.
- `healthcheck.sh` — local health endpoint check.

The API defaults to `HOST=127.0.0.1`; only Caddy should accept public traffic.
Set `HOST=0.0.0.0` only in a deliberately reviewed environment such as a
container network that requires it.

## Conservative initial limits

| Setting | Value | Why |
| --- | ---: | --- |
| V8 old-space | 512 MiB | Leaves RAM for SQLite, the OS, and Caddy. |
| systemd `MemoryMax` | 850 MiB | A hard guardrail instead of risking whole-VPS OOM. |
| One file plaintext | 25 MiB | Suitable for early chat/image usage on the small VPS. |
| Stored encrypted blob | 26 MiB | Allows bounded authenticated-encryption overhead. |
| Temp encrypted backup / user | 1 GiB | Keeps a useful restore window without defaulting to multi-GiB files. |
| Sticker/GIF quota / user | 128 MiB | Conservative future allocation. |

The streaming blob write path enforces the stored-blob cap as bytes arrive, so
a declared file size cannot make the process buffer a 2 GiB upload in RAM.
There is currently no server-wide disk quota, so monitor filesystem usage and
reserve headroom for SQLite's WAL and backups.

## Manual operator sequence

1. Provision Debian 12 and a real DNS name outside this repository.
2. Install a supported Node 22 runtime and Caddy using a reviewed OS process.
3. Create a non-login `frontierx` service account and the layout above with
   ownership that lets only that account write `/var/lib/frontierx`.
4. On a builder, run `npm run build` then `npm run package:lean`; validate the
   resulting `release/`, then place its contents under `/srv/frontierx/current`.
5. Copy `api.env.example` to `/etc/frontierx/api.env`, retain the loopback
   bind, and restrict its permissions.
6. Review and install the systemd and Caddy templates with the real domain and
   file paths. This is the point where normal server-administration permission
   is required; this repository intentionally does not automate it.
7. Verify the loopback health endpoint with `sh deploy/lite/healthcheck.sh`,
   then validate Caddy HTTPS, `/api/health`, WebSocket connections, login, and
   a small encrypted-file upload from a real browser.

## Backup and recovery

Back up both the SQLite database and blob directory. A raw copy of an active
SQLite database is not a tested backup procedure. Use a SQLite-aware backup or
briefly stop the API before taking a matching database-plus-blob snapshot; then
exercise a restore in staging. Protect backups as sensitive encrypted user
data, even though file payloads are client-encrypted.

Before any public or long-lived deployment, add: a verified automated backup
job, disk-usage alerting, service monitoring, a restore drill, and a staging
load/security test. None of those is represented as complete by these files.
