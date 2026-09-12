# Roadmap

## Phase 0 — Backend foundation (current)

- NestJS API
- PostgreSQL, Redis, Prisma
- Docker Compose
- Health, request IDs, validation, security middleware
- Tests and documentation

## Phase 1 — Identity

- Users, registration, login
- JWT access and refresh tokens
- Password hashing and session invalidation

## Phase 2 — Documents

- Document records
- Uploads and object storage
- Basic metadata and listing

## Phase 3 — Capture and understanding

- OCR
- PDF and image processing
- AI gateway (OpenAI, Gemini, Anthropic, others)

## Phase 4 — Conversion and creation

- Format conversion
- Generated artifacts from understood documents

## Phase 5 — Platform

- Credits and subscriptions
- Payments
- Admin dashboard
- Android client
- Nginx reverse proxy
- Push notifications (FCM)
- Background workers (BullMQ)

Each phase should keep the Phase 0 envelope, request ID, health checks, and fail-fast configuration. Do not start a later phase until the previous phase is working.
