# DocuAI

DocuAI is a document intelligence platform (document management, OCR and AI
assistance) with an Android-first client. This repository contains the backend
API, built incrementally in phases.

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 0 | Project foundation: NestJS, PostgreSQL, Redis, Prisma, Docker, health, request IDs, validation, security, error handling | Done |
| 1 | Authentication & user management: registration, login, JWT access tokens, rotating refresh tokens with reuse detection, logout, profile, guards, auth rate limits, security events | Done |

## Stack

- **Runtime:** Node.js 22, TypeScript
- **Framework:** NestJS 11 (Express)
- **Database:** PostgreSQL 16 via Prisma 6
- **Cache / rate limiting:** Redis 7 via ioredis
- **Auth:** Argon2id password hashing, HS256 JWT access tokens (passport-jwt), opaque HMAC-hashed refresh tokens
- **Containers:** Docker Compose (`postgres`, `redis`, `backend`)

## Repository layout

```
.
├── backend/                 NestJS API
│   ├── prisma/              Prisma schema and migrations
│   ├── src/
│   │   ├── auth/            Register, login, refresh, logout, me; JWT strategy/guard
│   │   ├── common/          Cross-cutting: envelope, filters, request ID, error codes
│   │   ├── config/          Typed configuration + env validation
│   │   ├── health/          GET /api/v1/health
│   │   ├── prisma/          PrismaService (global)
│   │   ├── redis/           RedisService (global)
│   │   ├── security/        PasswordService (Argon2id), SecurityEventsService
│   │   └── users/           User persistence, profile endpoints, safe serializer
│   └── test/                e2e tests and test utilities
├── docker/                  Container init scripts
├── docs/                    Architecture, API, database and project specs
└── docker-compose.yml
```

## Quick start (Docker)

```bash
docker compose up -d --build
docker compose ps                       # all three services should be "healthy"
curl -s http://localhost:4310/api/v1/health
```

The API listens on `http://localhost:4310/api/v1`. OpenAPI docs are served at
`http://localhost:4310/api/v1/docs` outside production.

Host ports are `5433` (PostgreSQL) and `6380` (Redis) to avoid clashing with
local installations; override with `POSTGRES_PORT` / `REDIS_PORT`.

Useful commands inside the container:

```bash
docker compose exec backend npx prisma validate
docker compose exec backend npx prisma migrate status
docker compose exec backend npm run build
docker compose exec backend npm test
docker compose exec backend npm run lint
```

## Local development (without Docker for the API)

Requires a running PostgreSQL and Redis. Create the databases `docuai` and
`docuai_test`, then:

```bash
cd backend
cp .env.example .env            # adjust DATABASE_URL / REDIS_URL if needed
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

## Testing

```bash
cd backend
npm test          # unit + e2e (uses TEST_DATABASE_URL and Redis db 1)
npm run test:unit
npm run test:e2e
```

Tests refuse to run unless `TEST_DATABASE_URL` is set and differs from
`DATABASE_URL`; they never reset or drop a database, only `migrate deploy` and
truncate tables in the test database.

## Configuration

All configuration comes from environment variables, validated at boot (see
`backend/.env.example`). The application refuses to start on invalid config.

For Docker Compose, optional overrides (ports, database credentials, JWT
secrets) go in a root-level `.env` (see `.env.example`). The compose file
ships development-only JWT secrets; the backend refuses them when
`NODE_ENV=production`, so always set `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` for real deployments:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Authentication in 60 seconds

```bash
# Register (creates the account and a first session)
curl -s -X POST localhost:4310/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"strong-password","name":"John Doe"}'

# Use the access token
curl -s localhost:4310/api/v1/auth/me -H "Authorization: Bearer $ACCESS_TOKEN"

# Rotate: returns a NEW access token and a NEW refresh token; the old refresh token dies
curl -s -X POST localhost:4310/api/v1/auth/refresh \
  -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"

# Log out this device only
curl -s -X POST localhost:4310/api/v1/auth/logout -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
```

Key properties:

- Passwords are hashed with Argon2id and never trimmed, logged or returned.
- Access tokens are 15-minute HS256 JWTs carrying only `{ sub, iat, exp }`.
- Refresh tokens are 384-bit random strings; only an HMAC-SHA256 hash is
  stored. Every refresh rotates the token. Presenting an already-used token is
  treated as theft and revokes **all** sessions of the user.
- Login, register and refresh have their own stricter rate limits.
- Security events (`LOGIN_FAILED`, `REFRESH_TOKEN_REUSE_DETECTED`, …) are
  logged with ids and IPs only.

See [docs/API_SPEC.md](docs/API_SPEC.md) for the complete contract.

## Response envelope

Every endpoint returns one of two shapes:

```json
{ "success": true,  "data": {}, "message": null, "requestId": "..." }
{ "success": false, "data": null, "code": "ERROR_CODE", "message": "...", "requestId": "..." }
```

The request ID is also returned in the `X-Request-Id` header and can be
supplied by the client for end-to-end correlation.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API specification](docs/API_SPEC.md)
- [Database](docs/DATABASE.md)
- [Project specification](docs/PROJECT_SPEC.md)
