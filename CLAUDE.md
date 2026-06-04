# SelfBase

Self-hosted infrastructure manager: PostgreSQL backup scheduling + Redis monitoring for the CloudPipe ecosystem.

## Stack
- Node.js (zero-framework, raw `http` module)
- `better-sqlite3` — only runtime dependency (local metadata store, WAL mode)
- PostgreSQL CLI tools (`pg_dump`, `pg_restore`, `psql`) shelled out via `execFile`
- Redis/Memurai (Windows service) accessed over raw TCP socket (RESP protocol)
- PM2 for process management (`.pm2-ecosystem.json`), port 4023

## Directory structure

```
server.js          ← HTTP server, router, auth, rate limiting, route handlers
db.js              ← better-sqlite3 init, schema, settings get/set
pg-backup.js       ← pg_dump/pg_restore: backup, restore, cleanup, list
pg-monitor.js      ← psql: connection health + DB stats (size, connections, tables)
redis-manager.js   ← RESP-over-TCP Redis health, start (Memurai service), stop
data/              ← selfbase.db (SQLite) + backups/ (dump files)
.env / .env.example ← config (PORT, SELFBASE_TOKEN, PG_BIN_PATH, passwords)
.pm2-ecosystem.json ← PM2 app definition + production env
```

## Key concepts

- **No web framework**: `server.js` uses Node's `http` module directly. Routing is a hand-written `matchRoute(method, pathname)` returning `{ handler, auth, params }`.
- **Auth**: Bearer token (`SELFBASE_TOKEN`) compared with `crypto.timingSafeEqual`. `/api/health` is the only public route; all others require auth.
- **Rate limiting**: in-memory `Map` by IP — 60 req/min unauth, 300 req/min auth; swept every 5 min.
- **SQLite schema** (`db.js`): `databases` (registered PG targets, soft-delete via `is_active`), `backups` (history with status `running`/`completed`/`failed`/`deleted`), `settings` (key/value, seeded defaults).
- **Backups** (`pg-backup.js`): `pg_dump` to `data/backups/`. Format `custom` (`-Fc`, `.dump`) or plain (`.sql`). Per-DB password via `PG_PASSWORD_<ID>` env, falling back to `PG_PASSWORD`. `runBackupAll` uses `Promise.allSettled`. Cleanup enforces `retention_count` + `retention_days`, plus purges failed backups >7 days.
- **Restore** (`pg-backup.js`): `.dump` → `pg_restore --clean --if-exists`; `.sql` → `psql -f`. Optional `target_database_id` to restore into a different DB.
- **PG monitoring** (`pg-monitor.js`): runs `psql -t -A` queries for `version()`, DB size, active connections, and top-20 table sizes/row counts.
- **Redis** (`redis-manager.js`): hand-rolled RESP encoder over a TCP socket to `127.0.0.1:6379`. Optional `AUTH` if `REDIS_PASSWORD` set. `startRedis` runs `net start <MEMURAI_SERVICE>`; `stopRedis` sends `SHUTDOWN NOSAVE` (ECONNRESET treated as success).
- **Env loading**: `server.js` parses `.env` manually (no dotenv dependency); existing `process.env` values take precedence.

## Commands

```bash
npm install
PORT=4023 node server.js     # or: npm start
```

PM2 (production): `pm2 start .pm2-ecosystem.json`

## API endpoints (see README.md for full table)

- Public: `GET /api/health`
- Databases: `GET|POST /api/databases`, `DELETE /api/databases/{id}`
- Backups: `POST /api/backup`, `POST /api/backup/all`, `GET /api/backups`, `POST /api/restore`, `POST /api/cleanup`
- Monitoring: `GET /api/pg/stats?database_id=...`, `GET /api/redis/health`, `POST /api/redis/start`, `POST /api/redis/stop`
- Settings: `GET|PUT /api/settings` (allowed keys: `retention_count`, `retention_days`, `backup_format`, `pg_bin_path`)

## Coding rules

- **No external web framework / no dependencies beyond `better-sqlite3`** — keep it dependency-light.
- **`execFile` (never `exec`)** for shelling out to PG/Redis tools — array args, no shell string interpolation.
- **Parameterized SQLite queries** via prepared statements.
- **Settings-first config**: prefer `getSetting()` over reading `process.env` directly (e.g. `pg_bin_path`).
- Module pattern: CommonJS `require`/`module.exports`, one concern per file.
