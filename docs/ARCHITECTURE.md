# DocuAI Architecture

## Overview

DocuAI is a modular NestJS monolith backed by PostgreSQL and Redis. Each
product capability lives in its own Nest module; cross-cutting concerns are
implemented once in `backend/src/common` and applied globally.

```
Android / API clients
        │  HTTPS, Authorization: Bearer <access JWT>
        ▼
┌───────────────────────────────────────────────────────────────┐
│ NestJS API  (backend/)                                        │
│                                                               │
│  requestIdMiddleware ─► helmet ─► ThrottlerGuard              │
│        ─► JwtAuthGuard (default-deny, @Public() opt-out)      │
│        ─► ValidationPipe ─► Controller ─► Service             │
│        ─► ResponseEnvelopeInterceptor                         │
│   any error ─► HttpExceptionFilter (error envelope)           │
│                                                               │
│  Modules: Health · Auth · Users · Security (global)           │
│  PrismaService (global)        RedisService (global)          │
└────────────┬───────────────────────────────┬──────────────────┘
             ▼                               ▼
       PostgreSQL 16                      Redis 7
   users, refresh_tokens          rate-limit counters
```

## Source layout

```
backend/src
├── app.module.ts            root module: config, throttler, feature modules
├── app.setup.ts             configureApp(): prefix, helmet, CORS, pipes, filters, Swagger
├── main.ts                  bootstrap
├── common/                  envelope, exception filter, request ID, error codes, AppException
├── config/                  typed AppConfig loader + Joi env validation
├── prisma/                  PrismaService (global)
├── redis/                   RedisService (global)
├── security/                PasswordService (Argon2id), SecurityEventsService (global)
├── health/                  GET /health
├── users/                   UsersModule: persistence, profile, safe serializer
└── auth/                    AuthModule: register/login/refresh/logout/me, JWT, guards
    ├── dto/                 RegisterDto, LoginDto, RefreshTokenDto, LogoutDto, response DTOs
    ├── guards/              JwtAuthGuard (registered as APP_GUARD)
    ├── strategies/          JwtStrategy (passport-jwt, HS256)
    ├── decorators/          @Public(), @CurrentUser(), @AuthThrottle()
    ├── interfaces/          JwtPayload, AuthenticatedUser
    └── utils/               token.utils: CSPRNG refresh tokens + HMAC hashing
```

## Request pipeline

1. **Request ID** – `requestIdMiddleware` accepts a well-formed
   `X-Request-Id` (`[A-Za-z0-9._:-]{1,128}`) or generates a UUID. The ID is set
   on the response header and embedded in every envelope and security event.
2. **Security headers** – `helmet()` with defaults; `x-powered-by` disabled.
3. **CORS** – disabled unless `CORS_ORIGINS` lists explicit origins.
4. **Rate limiting** – `@nestjs/throttler` as a global guard, backed by Redis
   (`@nest-lab/throttler-storage-redis`) so limits are shared across
   instances. Default: `THROTTLE_LIMIT` requests per `THROTTLE_TTL` seconds
   per client IP. `/health` is excluded. Auth endpoints carry
   `@AuthThrottle('login' | 'register' | 'refresh')`, which resolves the
   stricter `AUTH_*_RATE_LIMIT/_WINDOW` values per request; each endpoint has
   its own bucket.
5. **Authentication** – `JwtAuthGuard` is a global guard: every route needs a
   valid bearer token unless decorated with `@Public()`. Failures become
   `401 AUTH_UNAUTHORIZED` (no token) or `401 AUTH_INVALID_TOKEN`
   (malformed / expired / bad signature).
6. **Validation** – global `ValidationPipe` with `whitelist`,
   `forbidNonWhitelisted`, `forbidUnknownValues` and `transform`. Unknown
   body fields are rejected with `VALIDATION_ERROR`.
7. **Envelope** – `ResponseEnvelopeInterceptor` wraps handler results in
   `{ success: true, data, message, requestId }`. Handlers can return an
   `ApiResult(data, message)` to set `message`.
8. **Errors** – `HttpExceptionFilter` catches everything and produces
   `{ success: false, data: null, code, message, requestId }`. Domain code
   throws `AppException(status, code, message)`. Unknown errors are logged with
   stack + request ID and returned as a generic `INTERNAL_ERROR`.

## Authentication architecture (Phase 1)

### Principles

- **Two token types.** A short-lived, stateless **access token** (JWT, HS256,
  default 15 min) authorises API calls. A long-lived, opaque **refresh token**
  (default 30 days) is the only long-term credential and is fully
  server-controlled: stored hashed, single-use, revocable.
- **Nothing sensitive in the JWT.** Payload is `{ sub: <userId>, iat, exp }`.
- **Nothing secret in the database.** Passwords are stored as Argon2id
  hashes; refresh tokens as HMAC-SHA256 hashes. A database dump yields neither
  passwords nor usable sessions.
- **Nothing secret in the logs.** Security events only carry ids, IPs and
  reasons; DTOs are never logged.
- **Generic failures.** Login returns `AUTH_INVALID_CREDENTIALS` for both
  unknown email and wrong password, with equalised Argon2 work (a decoy hash is
  verified when the email is unknown) so timing does not reveal account
  existence. Account status is only disclosed after the password matched.

### Components

| Component | Responsibility |
| --------- | -------------- |
| `PasswordService` | Argon2id (`m=64 MiB, t=3, p=4`) `hash()` / `verify()` / `needsRehash()`. Passwords are opaque: never trimmed or normalised. |
| `token.utils` | `generateRefreshToken()` (48 CSPRNG bytes → 64 base64url chars), `hashRefreshToken(token, JWT_REFRESH_SECRET)` (HMAC-SHA256 hex), `looksLikeRefreshToken()` shape check. |
| `JwtStrategy` / `JwtModule` | Sign and verify HS256 access tokens with `JWT_ACCESS_SECRET`; `validate()` only checks the subject is a UUID and yields `{ userId }` — no DB query per request. |
| `JwtAuthGuard` | Global default-deny guard honouring `@Public()`. |
| `@CurrentUser()` | Param decorator returning `{ userId }` or a single field. |
| `UsersService` | Persistence: `findByEmail` (normalised), `create`, `updateProfile`, `getActiveUser` (401/403 for missing, suspended, deleted). |
| `toPublicUser()` | Explicit field mapping – the only user shape the API emits. |
| `AuthService` | Register, login, refresh (rotation + reuse detection), logout. |
| `SecurityEventsService` | Structured security log: `REGISTER_SUCCESS/FAILED`, `LOGIN_SUCCESS/FAILED`, `LOGOUT`, `REFRESH_TOKEN_ROTATED/REJECTED/REUSE_DETECTED`. |

### Token lifecycle

```
register / login
  ├─ Argon2id hash / verify
  ├─ INSERT refresh_tokens (token_hash, expires_at, metadata)   ← raw token only in response
  └─ sign access JWT { sub }

API call
  └─ JwtAuthGuard verifies signature + exp (no DB)  → handler loads user if needed

refresh(raw)
  ├─ hash(raw) → SELECT refresh_tokens WHERE token_hash          (unknown → AUTH_REFRESH_TOKEN_INVALID)
  ├─ revoked_at set?      → REUSE: revoke ALL user sessions       → AUTH_REFRESH_TOKEN_REUSED
  ├─ expires_at passed?   → revoke this row                       → AUTH_REFRESH_TOKEN_EXPIRED
  ├─ user not ACTIVE?     → revoke this row                       → AUTH_ACCOUNT_SUSPENDED / DELETED
  └─ TRANSACTION
       ├─ UPDATE … SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL
       │     count = 0 → lost a race → treated as REUSE (see above)
       └─ INSERT new refresh_tokens row (inherits device_name)
     → new access JWT + new raw refresh token

logout(raw)  [bearer required]
  └─ hash(raw) → revoke that row if it belongs to the caller; always 200
```

Multi-device: every login creates an independent session row; logout revokes
only the presented one. Reuse detection is the only path that revokes all
sessions of a user.

### Why the access token is not checked against the database

Verifying the JWT locally keeps the hot path free of database traffic. The
trade-off is that a suspension or deletion takes effect for *new* sessions
immediately (login/refresh are refused) but an already-issued access token
remains valid for at most `JWT_ACCESS_EXPIRES_IN` (15 min by default) on
endpoints that do not load the user. Account-level endpoints (`/auth/me`,
`/users/me`) always load the user through `getActiveUser()` and therefore
reject suspended/deleted accounts instantly. Later phases that need instant
global revocation can add a Redis-backed deny list behind `JwtStrategy`.

### Configuration

| Variable | Purpose |
| -------- | ------- |
| `JWT_ACCESS_SECRET` | HS256 signing key, ≥ 32 chars, placeholder values rejected |
| `JWT_REFRESH_SECRET` | HMAC key for refresh-token hashing, must differ from the access secret; rotating it invalidates all sessions |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | lifetimes, `<n>[s|m|h|d]` |
| `AUTH_{LOGIN,REGISTER,REFRESH}_RATE_LIMIT/_WINDOW` | per-endpoint throttling |

The `docker-compose.yml` development defaults for the secrets are refused when
`NODE_ENV=production`.

## Configuration

`ConfigModule` is global. `env.validation.ts` (Joi) validates `process.env` at
boot and the app refuses to start on invalid configuration.
`configuration.ts` exposes a typed `AppConfig` object consumed via
`ConfigService<AppConfig, true>`.

`.env` is only read outside `NODE_ENV=test`; tests configure the environment
explicitly (`backend/test/test-env.ts`).

## Infrastructure services

- **PrismaService** extends `PrismaClient`; connects on module init,
  disconnects on shutdown, exposes `isHealthy()` (`SELECT 1`).
- **RedisService** wraps a single ioredis client (`lazyConnect`, bounded
  retries, offline queue disabled). A failed initial connection is logged, not
  fatal; health reports it as `down`. Rate limiting fails closed while Redis
  is unreachable (requests through throttled routes error rather than bypass
  the limit).

## Health

`GET /api/v1/health` returns `status`, `database`, `redis`, `uptime` and
`timestamp`. Any dependency being down yields `503 SERVICE_UNAVAILABLE`. The
Docker healthcheck for the backend calls this endpoint.

## Testing strategy

- Unit tests (`src/**/*.spec.ts`) cover pure components: filter, interceptor,
  middleware, configuration, password hashing, token utilities, serializer,
  security events.
- e2e tests (`test/**/*.e2e-spec.ts`) boot the real `AppModule` through
  `configureApp()` – the exact production pipeline – against the isolated
  test database (`TEST_DATABASE_URL`) and Redis db index 1. They cover
  registration, login, JWT validation, refresh rotation, reuse detection,
  concurrency, logout, profile, forbidden fields, rate limiting and log
  hygiene (a capturing logger asserts no password/token/hash ever reaches the
  log).
- `test/global-setup.ts` runs `prisma migrate deploy` on the test database.
  No test ever drops or resets a database.

## Containers

`docker-compose.yml` defines `postgres` (named volume, init script creating the
`*_test` database), `redis` (AOF persistence, named volume) and `backend`
(built from `backend/Dockerfile`, runs `prisma migrate deploy` before
starting). Both dependencies have healthchecks and the backend waits for them.
