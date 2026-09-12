# DocuAI

**AI-powered document operating system**

*Scan. Understand. Convert. Create.*

Phase 0 of DocuAI is the backend infrastructure foundation: a NestJS API, PostgreSQL, Redis, Prisma, Docker Compose, health checks, and baseline security. Authentication, documents, OCR, and AI features are intentionally not included yet.

## Architecture

Current Phase 0 path:

```
Android
   ↓
Backend API
   ↓
PostgreSQL
Redis
```

Target architecture (later phases):

```
Android
   ↓
Nginx
   ↓
NestJS API
   ├── PostgreSQL
   ├── Redis
   ├── Object Storage
   └── AI Gateway
          ├── OpenAI
          ├── Gemini
          ├── Anthropic
          └── other providers
```

`admin/` and `android/` are reserved for later phases. `infrastructure/nginx/` will front the API once reverse-proxy work begins.

## Prerequisites

- Docker Engine 24+ with Docker Compose v2
- Node.js 22 LTS (only required for host-side backend development)
- npm 10+

## Setup

```bash
git clone <repository-url>
cd docuai
docker compose up -d --build
```

The stack is ready when PostgreSQL and Redis are healthy and the backend is running.

## Docker commands

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend
docker compose exec postgres pg_isready -U docuai -d docuai
docker compose exec redis redis-cli ping
docker compose exec backend npx prisma migrate status
docker compose down          # keeps named volumes
docker compose down -v       # destroys database and Redis data
```

## Development commands

From `backend/`:

```bash
npm install
cp .env.example .env
# Point DATABASE_URL and REDIS_URL at localhost if the API runs on the host.

npm run start:dev
npm run build
npm run start:prod
npm test
npm run test:e2e
npm run lint
npm run format
npm run prisma:generate
npm run prisma:migrate
npm run prisma:migrate:deploy
npm run prisma:studio
```

## Health endpoint

```bash
curl http://localhost:3000/api/v1/health
```

Successful response:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "DocuAI API",
    "database": "up",
    "redis": "up"
  },
  "message": null,
  "requestId": "..."
}
```

Preserve a client request id:

```bash
curl -i -H "X-Request-ID: test-123" http://localhost:3000/api/v1/health
```

The API reuses `X-Request-ID: test-123` in the response header and body.

If PostgreSQL or Redis is unavailable, `GET /api/v1/health` reports the failed dependency instead of claiming the stack is healthy.

## Environment configuration

See `backend/.env.example`. Required variables:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development`, `production`, or `test` |
| `APP_PORT` | HTTP port (default `3000`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |

`JWT_*` values exist only for future compatibility. Phase 0 does not implement authentication. Do not commit `.env` files.

Production CORS cannot use a wildcard origin.

## Project structure

```
android/                 # Future Android client
admin/                   # Future admin dashboard
backend/                 # NestJS API
  src/common/            # Filters, interceptors, middleware, pipes
  src/config/            # Environment validation
  src/health/            # GET /api/v1/health
  src/prisma/            # Prisma client module
  src/redis/             # Redis client module
  prisma/                # Schema and migrations
infrastructure/
  docker/                # Extra Docker assets (later)
  nginx/                 # Reverse proxy (later)
docs/                    # Product and technical documentation
docker-compose.yml
```

## Documentation

- [Project spec](docs/PROJECT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API spec](docs/API_SPEC.md)
- [Database](docs/DATABASE.md)
- [Roadmap](docs/ROADMAP.md)
