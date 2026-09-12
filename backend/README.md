# DocuAI Backend

NestJS API for DocuAI Phase 0: configuration, health checks, Prisma, Redis, and baseline security.

## Scripts

```bash
npm run start:dev
npm run build
npm run start:prod
npm test
npm run lint
npm run prisma:generate
npm run prisma:migrate
npm run prisma:migrate:deploy
```

## Environment

Copy `.env.example` to `.env` and adjust hostnames for local (non-Docker) development:

```
DATABASE_URL=postgresql://docuai:docuai_dev_password@localhost:5432/docuai?schema=public
REDIS_URL=redis://localhost:6379
```

JWT variables are placeholders for later phases and are not used in Phase 0.

## Health

`GET /api/v1/health` reports application, PostgreSQL, and Redis status.
