# Phase 0 Database

PostgreSQL 16 is the system of record. Prisma migrations are committed under `backend/prisma/migrations` and are applied with `prisma migrate deploy`.

## SystemConfig

| Column | Type | Constraint |
| --- | --- | --- |
| id | UUID | Primary key, generated UUID |
| key | text | Unique, required |
| value | text | Required |
| createdAt | timestamp | Defaults to current timestamp |
| updatedAt | timestamp | Updated by Prisma |

The first migration is `20260909060000_phase_0_system_config`. Schema changes must use migrations, not `prisma db push`.
