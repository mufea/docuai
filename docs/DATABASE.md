# Database

## Engine

PostgreSQL 16 (`postgres:16-alpine` in Compose).

Connection:

```
postgresql://docuai:docuai_dev_password@postgres:5432/docuai?schema=public
```

On the host, replace `postgres` with `localhost`.

## ORM

Prisma 6 with versioned migrations under `backend/prisma/migrations`. Do not use `prisma db push` as the primary migration strategy.

Useful commands:

```bash
npm run prisma:generate
npm run prisma:migrate          # development
npm run prisma:migrate:deploy   # Docker / production-style apply
npx prisma validate
npx prisma migrate status
```

The backend entrypoint runs `prisma migrate deploy` before the API starts.

## Phase 0 model

`SystemConfig` is a minimal table so migrations, persistence, and Prisma Client can be verified without introducing product entities.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `TEXT` | UUID primary key (`@default(uuid())`) |
| `key` | `TEXT` | Unique |
| `value` | `TEXT` | |
| `createdAt` | `TIMESTAMP(3)` | Default `now()` |
| `updatedAt` | `TIMESTAMP(3)` | `@updatedAt` |

Users, documents, credits, and similar models belong to later phases.

## Persistence

Compose volume `docuai-postgres-data` stores PostgreSQL data. `docker compose down` keeps it. `docker compose down -v` deletes it.

## Redis

Redis 7 is used as a cache/session substrate. Phase 0 exposes `get`, `set`, `del`, and health ping only. BullMQ is not configured.
