# DocuAI Project Spec

## Product

**Name:** DocuAI  
**Vision:** AI-powered document operating system  
**Tagline:** Scan. Understand. Convert. Create.

DocuAI will let people capture documents, extract meaning, convert formats, and generate new artifacts from that understanding. This repository currently implements **Phase 0 only**: the backend operating environment those features will run on.

## Phase 0 scope

Phase 0 delivers a working local development environment:

- NestJS TypeScript API
- PostgreSQL 16
- Redis 7
- Prisma ORM with versioned migrations
- Docker Compose
- Validated environment configuration
- `GET /api/v1/health`
- Request ID propagation
- Global validation and error envelope
- Helmet, CORS, rate limiting, request size limits
- Prisma and Redis injectable services
- Tests, lint, and documentation

## Out of scope

The following belong to later phases and must not appear in Phase 0:

- Authentication, registration, login, JWT, refresh tokens, users
- Documents, file uploads, S3
- OCR, AI, PDF processing, image processing
- Credits, subscriptions, payments
- Admin dashboard, FCM
- BullMQ workers
- Business logic

JWT environment variables exist so later phases can adopt them without renaming configuration. They are unused.

## Non-functional requirements

- The process fails fast when `NODE_ENV`, `APP_PORT`, `DATABASE_URL`, or `REDIS_URL` is invalid.
- Clients never receive stack traces, secrets, passwords, or connection strings.
- Production CORS cannot use `*`.
- PostgreSQL and Redis data persist across `docker compose down` (named volumes). `docker compose down -v` is the destructive path.
- Health checks must not report a dependency as `up` when it is unavailable.

## Success criteria

`docker compose up -d --build` starts PostgreSQL, Redis, and the NestJS backend.

`GET /api/v1/health` returns a successful envelope when both dependencies are available.
