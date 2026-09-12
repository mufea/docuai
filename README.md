# DocuAI

DocuAI Phase 0 is the backend foundation for a document intelligence platform. This repository currently provides a production-minded NestJS API, PostgreSQL persistence through Prisma, Redis connectivity, dependency-aware health checks, request correlation, validation, throttling, and safe response envelopes.

## Layout

- `backend/` — NestJS API and Prisma migrations
- `android/` — reserved for the Android client in a later phase
- `admin/` — reserved for the administration UI in a later phase
- `infrastructure/` — reserved infrastructure extensions
- `docs/` — Phase 0 product and technical documentation

## Run

```bash
docker compose up -d --build
curl http://localhost:3000/api/v1/health
```

The compose stack starts PostgreSQL 16, Redis 7, applies committed Prisma migrations, and starts the API on port 3000. See `backend/.env.example` for configuration.

## Verify

```bash
docker compose exec backend npx prisma validate
docker compose exec backend npx prisma migrate status
docker compose exec backend npm run build
docker compose exec backend npm test
docker compose exec backend npm run lint
```

Phase 0 intentionally excludes authentication, document processing, queues, Android features, and the admin UI.
