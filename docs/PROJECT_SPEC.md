# DocuAI Project Specification

## Vision

DocuAI lets users capture, organise and understand documents from an Android
app: scanned pages are stored securely, processed with OCR and enriched with AI
(summaries, extraction, Q&A). Usage is metered through credits and
subscriptions.

## Delivery phases

| Phase | Name | Content |
| ----- | ---- | ------- |
| 0 | Foundation | NestJS project, Docker Compose (PostgreSQL, Redis, backend), Prisma, configuration validation, health endpoint, request IDs, strict validation, security headers, global error handling, response envelope, tests, docs |
| 1 | Authentication & User Management | Users, registration, login, JWT access tokens, opaque refresh tokens with rotation and reuse detection, logout, profile, guards, auth rate limiting, security events |
| 2+ | Later | Documents & file storage, OCR, AI, credits, subscriptions & payments, device/session management, sharing, admin, notifications |

Each phase builds strictly on top of the previous one without rewriting it.

## Non-functional requirements

- **Security first**: strict input validation, generic error messages for
  authentication failures, no secrets in logs or responses, rate limiting.
- **Observability**: request IDs on every response and log line related to a
  request; structured, level-controlled logging.
- **Reliability**: health endpoint reflecting real dependency state;
  containers with healthchecks; persistence through named volumes.
- **Testability**: every phase ships unit and e2e tests running against an
  isolated test database.
- **Consistency**: a single response envelope and stable error codes across
  all phases.

## Phase 0 acceptance (completed)

- Project structure, Docker Compose, PostgreSQL, Redis, NestJS, Prisma and
  migration tooling in place.
- `GET /api/v1/health` reports `database` and `redis` status.
- Request ID middleware, global validation, helmet, global exception filter and
  response envelope are wired and tested.
- Build, lint and tests pass; containers survive `docker compose down && up`
  with data persisted in volumes.

## Phase 1 — Authentication & User Management (completed)

Scope delivered:

- `User` model (`UserStatus` enum, normalised unique email, Argon2id password
  hash, profile fields) and `RefreshToken` model (hashed opaque tokens with
  expiry, revocation and optional session metadata), migration
  `20260912123536_phase1_auth_users_refresh_tokens`.
- Endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/logout`, `GET /auth/me`, `GET /users/me`, `PATCH /users/me`.
- Short-lived HS256 access JWTs (`{ sub, iat, exp }`), opaque CSPRNG refresh
  tokens stored only as HMAC-SHA256 hashes, atomic rotation on every refresh,
  reuse detection revoking every session of the affected user, per-device
  logout.
- Global default-deny `JwtAuthGuard` with `@Public()` opt-out and
  `@CurrentUser()` decorator.
- Stricter, configurable per-endpoint rate limits for login, register and
  refresh on top of the global limit.
- Structured security events (`REGISTER_*`, `LOGIN_*`, `LOGOUT`,
  `REFRESH_TOKEN_*`) that never contain passwords, tokens, hashes or emails.
- Explicit safe user serializer (`toPublicUser`) — `passwordHash` can never be
  returned.
- Stable `AUTH_*` error codes inside the Phase 0 envelope.
- OpenAPI documentation with bearer auth.
- 124 automated tests (unit + e2e) covering registration, login, JWT, refresh,
  reuse, concurrency, logout, profile, forbidden fields, rate limiting and log
  hygiene.

Explicitly out of scope (later phases): email verification, password reset,
social login, two-factor authentication, session listing / device management
UI, admin tooling, documents, OCR, AI, credits, payments, notifications,
background workers, Android client.
