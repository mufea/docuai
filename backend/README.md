# DocuAI Backend

NestJS Phase 0 API with PostgreSQL/Prisma and Redis.

## Local configuration

Copy `.env.example` to `.env` when running outside Docker and update dependency hostnames (`postgres` and `redis`) to `localhost`.

## Commands

```bash
npm install
npx prisma generate
npm run start:dev
npm run build
npm test
npm run lint
```

Committed migrations are applied by the container entry command before the API starts. Create future migrations with `npx prisma migrate dev --name <name>` against a development database; do not use `db push`.

The API uses the global prefix `/api/v1`. Authentication is deliberately not implemented in Phase 0.
