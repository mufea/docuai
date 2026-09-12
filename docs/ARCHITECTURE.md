# Architecture

## Phase 0

```
Android (future)
   ↓
Backend API (NestJS)
   ↓
PostgreSQL    Redis
```

Compose starts three services on `docuai-network`:

| Service | Image / build | Port | Volume |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | 5432 | `docuai-postgres-data` |
| `redis` | `redis:7-alpine` | 6379 | `docuai-redis-data` |
| `backend` | `./backend` (development target) | 3000 | none |

The backend waits until PostgreSQL and Redis healthchecks pass, then runs `prisma migrate deploy` and starts the HTTP server on `0.0.0.0:3000`. Compose maps `postgres` and `redis` to the Docker host gateway so the API can use the published ports with the documented `DATABASE_URL` / `REDIS_URL` hostnames.

## NestJS layout

- `ConfigModule` loads and validates environment variables.
- `PrismaModule` / `PrismaService` own a singleton Prisma client.
- `RedisModule` / `RedisService` own an ioredis client (`get` / `set` / `del` / `ping`).
- `HealthModule` probes both dependencies with a timeout.
- Global prefix: `api/v1`.
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- `RequestIdMiddleware` reuses a valid `X-Request-ID` or generates a UUID.
- `ResponseInterceptor` wraps successes.
- `HttpExceptionFilter` wraps failures without stack traces.
- Helmet, compression, CORS, throttling, and a 1 MB JSON body limit.

## Logging

Structured logs (pino) include timestamp, level, request ID, method, path, and status. Authorization headers, cookies, passwords, tokens, and connection strings are redacted.

## Future architecture

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

Nginx, object storage, the AI gateway, and the Android/admin clients are not part of Phase 0. Empty trees exist at `android/`, `admin/`, `infrastructure/docker/`, and `infrastructure/nginx/`.
