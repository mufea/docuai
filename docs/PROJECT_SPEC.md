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
| 2 | Document & File Management | Folders (tree), documents (metadata, lifecycle, soft delete), private S3-compatible object storage behind a provider abstraction, presigned upload/download flow with server-side verification, ownership enforcement, file validation |
| 3 | OCR & Document Text Extraction | Native PDF text extraction, real OCR (Tesseract) for scanned PDFs and images, per-page results with confidence, asynchronous BullMQ worker on the existing Redis, job lifecycle with bounded retries and crash recovery, multi-language support, resource limits, OCR health |
| 4+ | Later | AI, credits, subscriptions & payments, device/session management, sharing, admin, notifications |

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

## Phase 2 — Document & File Management (completed)

Scope delivered:

- `Folder` model (per-user tree via `parent_id`, max depth 10) and
  `Document` model (`DocumentStatus` enum `DRAFT | UPLOADING | READY |
  PROCESSING | FAILED | DELETED`, title/description, verified MIME type and
  size, server-generated unique `storage_key`, sanitised original name, soft
  delete via `deleted_at`), migration
  `20261009024920_phase2_documents_folders` (strictly additive).
- Folder endpoints: `POST/GET /folders`, `GET/PATCH/DELETE /folders/:id`.
  Self-parenting and cycles are rejected (`INVALID_FOLDER`,
  `FOLDER_CYCLE_DETECTED`); deleting a folder moves its documents to the root
  and promotes child folders to its parent inside one transaction guarded by
  a per-user advisory lock.
- Document endpoints: `POST/GET /documents` (pagination, folder/status
  filters, search, allow-listed sort), `GET/PATCH/DELETE /documents/:id`.
- Upload/download flow: `POST /documents/:id/upload-url` (declaration →
  presigned `PUT`, type and size signed), `POST /documents/:id/upload-complete`
  (server `HEAD`s the object and verifies existence, size and type before
  `READY`; mismatches remove the object and mark the document `FAILED`),
  `GET /documents/:id/download-url` (presigned `GET`, 5-minute default,
  `READY` documents only, attachment disposition).
- Storage abstraction `StorageProvider` with an S3-compatible implementation
  (AWS SDK v3) — the only place that knows about S3 — plus a private RustFS
  object storage service in Docker Compose (persistent volume, healthcheck,
  loopback-only port, env credentials, no anonymous access, bucket
  auto-created outside production only).
- Ownership enforced on every query from the JWT subject; unknown, deleted
  and foreign ids are indistinguishable (`DOCUMENT_NOT_FOUND` /
  `FOLDER_NOT_FOUND`) while `*_ACCESS_DENIED` security events record probes.
- File validation: configurable MIME allowlist (`application/pdf`,
  `image/jpeg`, `image/png`, `image/webp`), configurable size limit (50 MiB
  default), zero/negative sizes rejected, extension/MIME consistency, file
  names sanitised (path traversal, null bytes, control characters, reserved
  characters, Unicode normalisation, length) and never used as storage keys.
- Tighter per-IP throttling for presigned URL endpoints; `ActiveUserGuard`
  rejects suspended/deleted accounts on every document/folder call.
- New stable error codes (`DOCUMENT_NOT_FOUND`, `FOLDER_NOT_FOUND`,
  `INVALID_FOLDER`, `FOLDER_CYCLE_DETECTED`, `FOLDER_DEPTH_EXCEEDED`,
  `INVALID_UPLOAD`, `UPLOAD_NOT_FOUND`, `UPLOAD_NOT_READY`, `FILE_TOO_LARGE`,
  `UNSUPPORTED_FILE_TYPE`, `STORAGE_ERROR`) inside the Phase 0 envelope.
- Security events `DOCUMENT_*`, `FOLDER_*`, `UPLOAD_URL_CREATED`,
  `UPLOAD_COMPLETED`, `UPLOAD_REJECTED`, `DOWNLOAD_URL_CREATED` carrying ids
  only — never presigned URLs, keys, credentials or file names.
- Health endpoint reports `storage`; OpenAPI documents all new endpoints.
- 311 automated tests (unit + e2e against real PostgreSQL, Redis and object
  storage) including an explicit IDOR matrix for documents and folders.

Explicitly out of scope (later phases): OCR, AI processing, PDF conversion /
thumbnails / page counting, sharing and public links, annotations, credits,
payments, notifications, admin tooling, vector databases, background queues,
hard deletion / retention jobs, document recovery, Android client.

Phase 0 and Phase 1 behaviour (authentication contract, response envelope,
error codes, request IDs, rate limiting) is unchanged.

## Phase 3 — OCR & Document Text Extraction (completed)

Scope delivered:

- `OcrJob` and `OcrPage` models with `OcrJobStatus`
  (`QUEUED | PROCESSING | COMPLETED | PARTIAL | FAILED | CANCELLED`),
  `OcrExtractionMethod` (`NATIVE_TEXT | OCR | MIXED`) and `OcrPageStatus`
  (`COMPLETED | EMPTY | FAILED`), migration
  `20261009061030_phase3_ocr_jobs_pages` (strictly additive). Page-level
  text, method, confidence, character count and truncation flag are
  persisted per job; jobs are immutable once terminal.
- Real extraction pipeline, no mocks: byte-signature validation of the stored
  object against the document's verified MIME type; `pdfinfo` for page
  counts; `pdftotext` for native text layers; `pdftoppm` rendering at a
  bounded DPI (150 dpi default, lowered automatically to respect
  `OCR_MAX_RENDER_PIXELS`) and Tesseract 5 (CLI, `OMP_THREAD_LIMIT=1`) for
  scanned pages and JPEG/PNG/WebP images. A deterministic, documented rule
  decides per page between native text and OCR (≥ 20 collapsed characters
  and ≥ 50 % alphanumeric content → native; otherwise OCR) — never both.
  Confidence is the mean Tesseract word confidence (0–100) and `null` for
  native text.
- Asynchronous processing with BullMQ on the existing Redis: one queue
  (`OCR_QUEUE_NAME`), bounded concurrency (1–2), per-page and per-job
  timeouts, exponential-backoff retries bounded by `OCR_MAX_RETRIES`, the
  database as source of truth (conditional claim, heartbeat, page upserts on
  `(job, page)`, status derived from persisted pages), resume from the last
  persisted page after a crash, a reconciler that re-enqueues orphaned
  `QUEUED` jobs and recovers or fails stale `PROCESSING` jobs
  (`OCR_WORKER_INTERRUPTED`) so no job stays `PROCESSING` forever, graceful
  shutdown, and duplicate-delivery safety. The worker runs embedded in the
  API container by default and can be split out with `OCR_WORKER_ENABLED`.
- Endpoints: `POST /documents/:id/ocr` (202 for a new job, 200 for an
  existing active/completed job, `forceReprocess`, optional `language`),
  `GET /documents/:id/ocr`, `GET /documents/:id/ocr/results` (paginated
  pages, bounded page size, 1-based `pageNumber` filter, `jobId` selection),
  `POST /documents/:id/ocr/retry` (only `FAILED`/`PARTIAL` jobs with a
  non-permanent error, bounded by the per-document job limit).
- Languages `ind, eng, msa, ara, chi_sim, jpn, kor, deu, fra, spa` installed
  in the image and advertised only when the Tesseract data is actually
  present; default `ind+eng`; up to three languages per job; no dynamic
  downloads and no automatic language detection.
- Resource limits: file size, page count (100), render DPI and pixel caps,
  image pixel cap, text per page and per document (truncation flagged),
  active jobs per user, jobs per document, OCR request rate limit; temp files
  live in a server-named directory and are removed in `finally`.
- Ownership enforced on every endpoint via the Phase 2 document lookup;
  foreign, unknown and deleted documents answer `404 DOCUMENT_NOT_FOUND`; job
  ids never authorise anything. New stable `OCR_*` error codes inside the
  Phase 0 envelope; security events `OCR_JOB_REQUESTED`,
  `OCR_RETRY_REQUESTED` and `DOCUMENT_ACCESS_DENIED` carry ids only.
  Extracted text, presigned URLs, storage keys and tool output are never
  logged or persisted on jobs.
- Health: `GET /health` gains an informational `ocr` block (engine,
  renderer, installed languages, worker, queue) that never fails unrelated
  requests; `GET /health/ocr` returns the full report (503 when the engine
  is missing).
- Docker: Tesseract, the ten language packs and Poppler are installed in the
  backend image; no additional services.
- 426 automated tests (unit + e2e against real PostgreSQL, Redis, object
  storage, Poppler and Tesseract) with committed deterministic fixtures:
  native-text, scanned, mixed and multi-page PDFs, PNG/JPEG/WebP images,
  blank image, corrupt PDF/PNG, wrong-type file; API, IDOR, limit, lifecycle,
  timeout, crash-recovery, duplicate-delivery and idempotency tests.

Explicitly out of scope (later phases): AI processing (summaries, extraction,
Q&A), full-text search, language detection, handwriting recognition, layout
or table reconstruction, thumbnails/PDF conversion, credits/metering,
payments, sharing, notifications, admin tooling, retention/hard deletion,
Android client.

Phase 0, 1 and 2 behaviour is unchanged: the document lifecycle and
`DocumentStatus` values are untouched (documents stay `READY` while OCR
runs), the storage provider only gained a server-side read, and no existing
endpoint, error code or response shape changed.
