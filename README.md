# DocuAI

DocuAI is a document intelligence platform (document management, OCR and AI
assistance) with an Android-first client. This repository contains the backend
API, built incrementally in phases.

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 0 | Project foundation: NestJS, PostgreSQL, Redis, Prisma, Docker, health, request IDs, validation, security, error handling | Done |
| 1 | Authentication & user management: registration, login, JWT access tokens, rotating refresh tokens with reuse detection, logout, profile, guards, auth rate limits, security events | Done |
| 2 | Document & file management: folders, documents with soft delete, private S3-compatible object storage, presigned upload/download with server-side verification, ownership enforcement, file validation | Done |
| 3 | OCR & text extraction: native PDF text, real Tesseract OCR for scanned PDFs and images, per-page results with confidence, asynchronous BullMQ worker with retries and crash recovery, multi-language support, resource limits, OCR health | Done |

## Stack

- **Runtime:** Node.js 22, TypeScript
- **Framework:** NestJS 11 (Express)
- **Database:** PostgreSQL 16 via Prisma 6
- **Cache / rate limiting / job queue:** Redis 7 via ioredis; BullMQ for the OCR queue (same Redis)
- **Object storage:** any S3-compatible service via AWS SDK v3 behind a `StorageProvider` abstraction (RustFS in Docker Compose)
- **OCR:** Tesseract 5 and Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) installed in the backend image, behind an `OcrProvider` abstraction
- **Auth:** Argon2id password hashing, HS256 JWT access tokens (passport-jwt), opaque HMAC-hashed refresh tokens
- **Containers:** Docker Compose (`postgres`, `redis`, `storage`, `backend`) — the OCR worker runs inside `backend`

## Repository layout

```
.
├── backend/                 NestJS API
│   ├── prisma/              Prisma schema and migrations
│   ├── src/
│   │   ├── auth/            Register, login, refresh, logout, me; JWT strategy/guard
│   │   ├── common/          Cross-cutting: envelope, filters, request ID, error codes
│   │   ├── config/          Typed configuration + env validation
│   │   ├── documents/       Document CRUD, soft delete, presigned upload/download flow
│   │   ├── folders/         Folder tree CRUD with cycle/depth protection
│   │   ├── health/          GET /api/v1/health, GET /api/v1/health/ocr
│   │   ├── ocr/             OCR jobs: extraction pipeline, Tesseract provider, BullMQ worker, endpoints
│   │   ├── prisma/          PrismaService (global)
│   │   ├── redis/           RedisService (global)
│   │   ├── security/        PasswordService (Argon2id), SecurityEventsService
│   │   ├── storage/         StorageProvider abstraction + S3-compatible provider
│   │   └── users/           User persistence, profile endpoints, safe serializer
│   └── test/                e2e tests, test utilities and deterministic OCR fixtures
├── docker/                  Container init scripts
├── docs/                    Architecture, API, database and project specs
└── docker-compose.yml
```

## Quick start (Docker)

```bash
docker compose up -d --build
docker compose ps                       # all four services should be "healthy"
curl -s http://localhost:4310/api/v1/health
```

The API listens on `http://localhost:4310/api/v1`. OpenAPI docs are served at
`http://localhost:4310/api/v1/docs` outside production.

Host ports are `5433` (PostgreSQL), `6380` (Redis) and `9000` (object
storage, bound to `127.0.0.1`) to avoid clashing with local installations;
override with `POSTGRES_PORT` / `REDIS_PORT` / `STORAGE_PORT` in a root
`.env`. If you change `STORAGE_PORT`, also set `S3_PUBLIC_ENDPOINT`
(e.g. `http://localhost:9001`) so presigned URLs point at the new port.

Useful commands inside the container:

```bash
docker compose exec backend npx prisma validate
docker compose exec backend npx prisma migrate status
docker compose exec backend npm run build
docker compose exec backend npm test
docker compose exec backend npm run lint
```

Check the OCR runtime inside the container:

```bash
docker compose exec backend tesseract --list-langs
docker compose exec backend pdftoppm -v
curl -s http://localhost:4310/api/v1/health/ocr
```

## Local development (without Docker for the API)

Requires a running PostgreSQL, Redis and an S3-compatible object store (the
compose `storage` service works: `docker compose up -d storage`), plus
Tesseract 5 with the language packs you want and Poppler utilities for OCR
(see `backend/README.md`). Create the databases `docuai` and `docuai_test`,
then:

```bash
cd backend
cp .env.example .env            # adjust DATABASE_URL / REDIS_URL / S3_* if needed
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

## Testing

```bash
cd backend
npm test          # unit + e2e (uses TEST_DATABASE_URL, Redis db 1 and TEST_S3_BUCKET)
npm run test:unit
npm run test:e2e
```

Tests refuse to run unless `TEST_DATABASE_URL` is set and differs from
`DATABASE_URL`; they never reset or drop a database, only `migrate deploy` and
truncate tables in the test database. Upload/download tests run against the
real object store using a separate bucket (`TEST_S3_BUCKET`, default
`<S3_BUCKET>-test`) and refuse to use the development bucket. OCR tests run
the real Tesseract/Poppler toolchain against the committed fixtures in
`backend/test/fixtures/ocr/` and use a dedicated queue name.

## Configuration

All configuration comes from environment variables, validated at boot (see
`backend/.env.example`). The application refuses to start on invalid config.

For Docker Compose, optional overrides (ports, database credentials, JWT
secrets, storage credentials) go in a root-level `.env` (see `.env.example`).
The compose file ships development-only JWT secrets and storage credentials;
the backend refuses them when `NODE_ENV=production`, so always set
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `STORAGE_ACCESS_KEY` and
`STORAGE_SECRET_KEY` for real deployments:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Storage-related variables (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`,
presigned URL lifetimes, `MAX_DOCUMENT_FILE_SIZE_BYTES`,
`ALLOWED_DOCUMENT_MIME_TYPES`, presign rate limits) are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#phase-2-configuration).

OCR variables (`OCR_ENABLED`, `OCR_WORKER_ENABLED`, `OCR_DEFAULT_LANGUAGE`,
`OCR_SUPPORTED_LANGUAGES`, `OCR_MAX_CONCURRENCY`, `OCR_MAX_RETRIES`,
`OCR_JOB_TIMEOUT_MS`, `OCR_PAGE_TIMEOUT_MS`, `OCR_MAX_PDF_PAGES`,
`OCR_RENDER_DPI`, text/pixel/job limits, tool paths, OCR rate limit) are
listed with defaults in `backend/.env.example` and explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#phase-3-configuration).

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

## Documents in 60 seconds

Files never pass through the API: the client uploads to and downloads from
object storage with short-lived presigned URLs, and the server verifies the
stored object before a document becomes `READY`.

```bash
AUTH="Authorization: Bearer $ACCESS_TOKEN"; J='content-type: application/json'

# Folder + document (metadata only, status DRAFT)
FOLDER=$(curl -s -X POST localhost:4310/api/v1/folders -H "$J" -H "$AUTH" -d '{"name":"Invoices"}' | jq -r .data.id)
DOC=$(curl -s -X POST localhost:4310/api/v1/documents -H "$J" -H "$AUTH" \
  -d "{\"title\":\"Invoice March\",\"folderId\":\"$FOLDER\"}" | jq -r .data.id)

# Declare the file -> presigned PUT (Content-Type and Content-Length are signed)
SIZE=$(stat -c %s invoice.pdf)
UP=$(curl -s -X POST localhost:4310/api/v1/documents/$DOC/upload-url -H "$J" -H "$AUTH" \
  -d "{\"fileName\":\"invoice.pdf\",\"contentType\":\"application/pdf\",\"fileSize\":$SIZE}")
curl -s -X PUT "$(echo "$UP" | jq -r .data.uploadUrl)" -H 'Content-Type: application/pdf' --data-binary @invoice.pdf

# Server verifies the object (exists, size, type) -> READY
curl -s -X POST localhost:4310/api/v1/documents/$DOC/upload-complete -H "$J" -H "$AUTH" -d '{}'

# Download via a 5-minute presigned GET
curl -s localhost:4310/api/v1/documents/$DOC/download-url -H "$AUTH" | jq -r .data.downloadUrl | xargs curl -s -o invoice-copy.pdf

# List, update, soft-delete
curl -s "localhost:4310/api/v1/documents?folderId=$FOLDER&search=march" -H "$AUTH"
curl -s -X PATCH localhost:4310/api/v1/documents/$DOC -H "$J" -H "$AUTH" -d '{"title":"Invoice March (final)"}'
curl -s -X DELETE localhost:4310/api/v1/documents/$DOC -H "$AUTH"
```

Key properties:

- Every folder and document belongs to the authenticated user; foreign,
  unknown and deleted ids all answer `404 DOCUMENT_NOT_FOUND` /
  `404 FOLDER_NOT_FOUND`, and probes are logged as security events.
- Storage keys are generated server-side
  (`users/{userId}/documents/{documentId}/{random}`); client file names are
  sanitised and used for display only. The bucket is private; clients only
  ever see short-lived presigned URLs (upload 15 min, download 5 min).
- MIME allowlist (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`)
  and a 50 MiB size limit are enforced on the declaration, in the signed URL
  and again against the stored object. Mismatches mark the document `FAILED`
  and remove the object.
- Deleting a document is a soft delete; deleting a folder moves its documents
  to the root and promotes its sub-folders. Folder cycles and self-parenting
  are rejected.

## OCR in 60 seconds

OCR is asynchronous: a request creates a job, a worker processes the stored
file page by page, and results are read back per page.

```bash
AUTH="Authorization: Bearer $ACCESS_TOKEN"; J='content-type: application/json'

# Queue extraction for a READY document (202). Default language ind+eng.
curl -s -X POST localhost:4310/api/v1/documents/$DOC/ocr -H "$J" -H "$AUTH" -d '{"language":"eng"}'

# Poll the latest job: QUEUED -> PROCESSING -> COMPLETED | PARTIAL | FAILED
curl -s localhost:4310/api/v1/documents/$DOC/ocr -H "$AUTH" | jq '.data | {status, totalPages, processedPages, extractionMethod}'

# Page results (paginated; 409 OCR_NOT_READY while the job is still running)
curl -s "localhost:4310/api/v1/documents/$DOC/ocr/results?page=1&limit=10" -H "$AUTH" | jq '.data.pages[] | {pageNumber, method, confidence, charCount}'

# Re-run with another language, or retry a FAILED / PARTIAL job
curl -s -X POST localhost:4310/api/v1/documents/$DOC/ocr -H "$J" -H "$AUTH" -d '{"language":"ind+eng","forceReprocess":true}'
curl -s -X POST localhost:4310/api/v1/documents/$DOC/ocr/retry -H "$AUTH"
```

Key properties:

- PDFs with a usable text layer are read natively (`pdftotext`); scanned
  pages and images are rendered at a bounded DPI and recognised by Tesseract.
  The decision is made per page with a documented rule — a mixed PDF yields
  `NATIVE_TEXT` and `OCR` pages in one `MIXED` job, never duplicated text.
- `confidence` (0–100) is reported only for OCR'd pages; native text has
  `null` because nothing was measured.
- One active job per document; requesting again returns the existing job,
  and completed results are reused unless `forceReprocess` is set.
- The worker is bounded (concurrency, per-page/per-job timeouts, page, pixel
  and text limits) and recovers after a restart: progress is persisted per
  page, interrupted jobs resume or fail with `OCR_WORKER_INTERRUPTED`, and
  nothing stays `PROCESSING` forever.
- Ten languages ship in the image (`ind eng msa ara chi_sim jpn kor deu fra
  spa`); only installed ones are accepted and `/health/ocr` lists them.
- Extracted text, presigned URLs and storage keys never appear in logs.

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
- [Roadmap](docs/ROADMAP.md)
