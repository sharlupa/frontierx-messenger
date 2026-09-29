# FrontierX deployment

## Current recommended profile

Use [`lite/`](./lite/README.md) as the documented starting point for the
user's 2 vCPU / 2 GiB RAM / 30 GiB NVMe VPS and an initial group of roughly ten
concurrent people. It is a **documented profile only**: it does not deploy to a
server, obtain root privileges, change a firewall, or create TLS certificates.

The current runnable backend is one Node API/WebSocket process with SQLite and
filesystem blob storage. The frontend is a static Vite build served by Caddy.

## Historical Docker scaffold

`../docker-compose.yml`, PostgreSQL migrations, Redis, MinIO, and coturn are
historical scaffolding for a future architecture. They are not used by the
current API implementation and are intentionally not the recommended path for
the small VPS. In particular, do not install or expose coturn until the
separate 1:1 voice-call implementation, media-security review, and explicit
server-administration approval are complete.

## Runtime facts

- `apps/api/src/store.ts` currently uses on-disk SQLite via `DB_PATH`.
- Encrypted file blobs are stored under `FILE_BLOB_DIR`.
- The server has `GET /api/health` for a local health check.
- `../.env.example` contains only the environment variables the current API
  actually reads; use the lean profile's environment-file template in a
  deployment.
