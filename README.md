# SelfBase

Self-hosted infrastructure manager: PostgreSQL backup scheduling + Redis monitoring

Part of the [CloudPipe](https://github.com/Jeffrey0117/CloudPipe) ecosystem.

## Quick Start

```bash
npm install
npm install
PORT=4023 node server.js
```

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 4023) |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Get overall system health: PostgreSQL connection status, Redis status, and last backup time |
| GET | `/api/databases` | List all registered PostgreSQL databases |
| POST | `/api/databases` | Register a new PostgreSQL database for backup and monitoring |
| DELETE | `/api/databases/{id}` | Soft-delete (deactivate) a registered database |
| POST | `/api/backup` | Trigger a pg_dump backup for a specific database. Returns backup ID, filename, size, and duration. |
| POST | `/api/backup/all` | Trigger backup for ALL active databases. Used by daily schedule. |
| GET | `/api/backups` | List backup history with optional database filter |
| POST | `/api/restore` | Restore a database from a completed backup |
| POST | `/api/cleanup` | Manually trigger backup cleanup based on retention settings |
| GET | `/api/pg/stats` | Get PostgreSQL database statistics: size, connections, table sizes and row counts |
| GET | `/api/redis/health` | Get Redis health: version, memory usage, connected clients, keyspace stats |
| POST | `/api/redis/start` | Start Redis server via WSL |
| POST | `/api/redis/stop` | Stop Redis server via SHUTDOWN command |
| GET | `/api/settings` | Get SelfBase configuration: retention policy, backup format, PG bin path |
| PUT | `/api/settings` | Update SelfBase configuration |

## License

MIT
