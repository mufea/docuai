# DocuAI Architecture

## Overview

DocuAI is a modular NestJS monolith backed by PostgreSQL, Redis and an
S3-compatible object store. Each product capability lives in its own Nest
module; cross-cutting concerns are implemented once in `backend/src/common`
and applied globally. File bytes never pass through the API: clients upload
to and download from object storage with short-lived presigned URLs.

```
Android / API clients ──────────────────────────────────────────────┐
        │  HTTPS, Authorization: Bearer <access JWT>                │ PUT / GET
        ▼                                                           │ presigned URL
┌───────────────────────────────────────────────────────────────┐   │
│ NestJS API  (backend/)                                        │   │
│                                                               │   │
│  requestIdMiddleware ─► helmet ─► ThrottlerGuard              │   │
│        ─► JwtAuthGuard (default-deny, @Public() opt-out)      │   │
│        ─► ValidationPipe ─► Controller ─► Service             │   │
│        ─► ResponseEnvelopeInterceptor                         │   │
│   any error ─► HttpExceptionFilter (error envelope)           │   │
│                                                               │   │
│  Modules: Health · Auth · Users · Folders · Documents         │   │
│           Security (global) · Storage (global)                │   │
│  PrismaService (global)   RedisService (global)   S3 provider │   │
└──────┬───────────────────────────┬──────────────────────┬─────┘   │
       ▼                           ▼                      ▼ sign / HEAD / DELETE
 PostgreSQL 16                  Redis 7          S3-compatible object store ◄┘
 users, refresh_tokens,     rate-limit counters   private bucket (RustFS in
 folders, documents                               compose; any S3 in prod)
```

## Source layout

```
backend/src
├── app.module.ts            root module: config, throttler, feature modules
├── app.setup.ts             configureApp(): prefix, helmet, CORS, pipes, filters, Swagger
├── main.ts                  bootstrap
├── common/                  envelope, exception filter, request ID, error codes, AppException,
│                            UuidParamPipe, @RequestCtx(), shared text validation decorators
├── config/                  typed AppConfig loader + Joi env validation (incl. storage/documents/ocr)
├── prisma/                  PrismaService (global)
├── redis/                   RedisService (global)
├── security/                PasswordService (Argon2id), SecurityEventsService (global)
├── health/                  GET /health (database, redis, storage, ocr summary), GET /health/ocr
├── users/                   UsersModule: persistence, profile, safe serializer
├── auth/                    AuthModule: register/login/refresh/logout/me, JWT, guards
│   ├── dto/                 RegisterDto, LoginDto, RefreshTokenDto, LogoutDto, response DTOs
│   ├── guards/              JwtAuthGuard (APP_GUARD), ActiveUserGuard (per-request account check)
│   ├── strategies/          JwtStrategy (passport-jwt, HS256)
│   ├── decorators/          @Public(), @CurrentUser(), @AuthThrottle()
│   ├── interfaces/          JwtPayload, AuthenticatedUser
│   └── utils/               token.utils: CSPRNG refresh tokens + HMAC hashing
├── storage/                 StorageModule (global): StorageProvider abstraction, storage keys
│   └── s3/                  S3StorageProvider (AWS SDK v3, presigner, bucket bootstrap)
├── folders/                 FoldersModule: tree CRUD, cycle/depth checks, transactional delete
├── documents/               DocumentsModule: metadata CRUD, soft delete, upload/download flow
│   ├── dto/                 Create/Update/List, CreateUploadUrl, CompleteUpload
│   ├── decorators/          @PresignThrottle()
│   ├── documents.service.ts        metadata, ownership, listing, soft delete
│   ├── document-files.service.ts   upload-url / upload-complete / download-url
│   └── file-name.ts         untrusted file-name sanitisation, MIME helpers
└── ocr/                     OcrModule (Phase 3): text extraction & OCR
    ├── dto/                 RequestOcrDto, OcrResultsQueryDto
    ├── decorators/          @OcrThrottle()
    ├── providers/           OcrProvider abstraction + TesseractOcrProvider
    ├── tools/               run-command (subprocess + kill), file-signature, poppler, text rules
    ├── ocr.controller.ts    POST/GET /documents/:id/ocr, /ocr/results, /ocr/retry
    ├── ocr.service.ts       API use cases: duplicate policy, quotas, ownership
    ├── ocr-job.service.ts   persistence: conditional transitions, page upserts, finalisation
    ├── ocr-extraction.service.ts  per-page pipeline (native text vs render+OCR)
    ├── ocr-queue.service.ts BullMQ producer (existing Redis)
    ├── ocr-worker.service.ts      BullMQ consumer + reconciler
    ├── ocr-languages.service.ts   configured ∩ installed languages
    ├── ocr-health.service.ts      engine / renderer / languages / queue / worker readiness
    └── ocr.errors.ts        safe OCR error codes, OcrProcessingError
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
   its own bucket. Presigned-URL endpoints carry `@PresignThrottle()`
   (`DOCUMENT_PRESIGN_RATE_LIMIT/_WINDOW`) in the same way.
5. **Authentication** – `JwtAuthGuard` is a global guard: every route needs a
   valid bearer token unless decorated with `@Public()`. Failures become
   `401 AUTH_UNAUTHORIZED` (no token) or `401 AUTH_INVALID_TOKEN`
   (malformed / expired / bad signature). Resource modules (folders,
   documents) additionally apply `ActiveUserGuard`, which loads the account
   and rejects suspended/deleted users on every call.
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

## Document & file management architecture (Phase 2)

### Principles

- **The caller is the owner.** Every folder and document row carries
  `user_id`; every query is `WHERE id = ? AND user_id = <jwt subject>` (plus
  `deleted_at IS NULL` for documents). The client can never name a user.
- **Uniform 404.** Unknown, soft-deleted and foreign ids are
  indistinguishable (`DOCUMENT_NOT_FOUND` / `FOLDER_NOT_FOUND`). When the id
  does exist for another user a `DOCUMENT_ACCESS_DENIED` /
  `FOLDER_ACCESS_DENIED` security event is recorded for investigation, but
  the response does not change.
- **Bytes never touch the API.** Uploads and downloads use presigned URLs;
  the API only signs, `HEAD`s and deletes objects. Clients never receive
  storage credentials, bucket policies or permanent URLs.
- **The server decides what is stored.** Storage keys, content type, size
  limits and the final `READY` state are all server-controlled. Client input
  is a *declaration* that is validated, signed into the upload URL and
  re-verified against the stored object before the document becomes `READY`.
- **Explicit serializers.** `toDocumentDto` / `toFolderDto` copy fields one
  by one; `userId`, `storageKey` and `deletedAt` never leave the API.
- **Strict DTOs.** `forbidNonWhitelisted` turns any attempt to send
  `userId`, `status`, `storageKey`, `mimeType`, `fileSize`, … into
  `400 VALIDATION_ERROR`. Query values are allow-listed (`sort`, `order`,
  `status`), so nothing user-controlled reaches an `ORDER BY`.

### Storage abstraction

`StorageProvider` (`backend/src/storage/storage.provider.ts`) is an abstract
class with the only operations the domain needs:

| Method | Purpose |
| ------ | ------- |
| `createUploadUrl({ key, contentType, contentLength, expiresInSeconds })` | Presigned `PUT`; `Content-Type` and `Content-Length` are part of the signature |
| `createDownloadUrl({ key, expiresInSeconds, responseContentType, responseContentDisposition })` | Presigned `GET` with forced response headers |
| `headObject(key)` → `{ size, contentType, etag, lastModified } \| null` | Verification on `upload-complete` |
| `objectExists(key)`, `deleteObject(key)` (idempotent), `isHealthy()` | Utilities / health |

`S3StorageProvider` is the only implementation (AWS SDK v3 + presigner). It
works with any S3-compatible service — RustFS in Docker Compose, MinIO, AWS
S3, Cloudflare R2, … — and is the only file that imports the SDK. It uses two
clients: one for API-side calls (`S3_ENDPOINT`, e.g. `http://storage:9000`
inside the compose network) and one for signing (`S3_PUBLIC_ENDPOINT`, the
host clients can reach), because SigV4 signs the `Host` header. Every SDK
error is logged with the operation name and mapped to a generic
`503 STORAGE_ERROR`; provider messages, bucket names and credentials are never
returned. On boot the provider checks the bucket exists (`HeadBucket`) and —
outside production, or when `S3_AUTO_CREATE_BUCKET=true` — creates it.
Bucket and objects stay private; no policy or ACL is ever applied.

The module is `@Global()` and binds `StorageProvider` through a factory, so a
different backend (filesystem, GCS, Azure) only needs a new class and one
line in `storage.module.ts`.

### Storage keys

`buildStorageKey(userId, documentId)` →
`users/{userId}/documents/{documentId}/{32 base64url chars from 24 CSPRNG bytes}`.

- Generated server-side on every `upload-url` call; a re-request gets a new
  key and the previous object (if any) is deleted best-effort.
- Both ids are validated as UUIDs; the random suffix makes keys
  non-guessable even if ids leak. `isServerGeneratedStorageKey()` documents
  the exact shape.
- The client file name is **never** part of the key. It is sanitised
  (`file-name.ts`: NFC normalisation, path components stripped, control /
  reserved characters removed, trailing dots trimmed, truncated to 255 with
  the extension preserved) and used only for display and the download
  `Content-Disposition` header (ASCII fallback + RFC 5987 `filename*`).

### Document lifecycle

```
POST /documents ──────────────────────────────► DRAFT
                                                  │ upload-url (declare name/type/size)
                                                  ▼
            ┌──────────────── upload-url again ── UPLOADING ◄── upload-url ── FAILED
            │                                     │ client PUTs to storage          ▲
            │                                     │ upload-complete                 │
            │                                     ├─ HEAD object missing → 409 UPLOAD_NOT_FOUND (stays UPLOADING)
            │                                     ├─ size/type/etag mismatch → object deleted, 409 INVALID_UPLOAD ─┘
            │                                     ▼
            └────────────────────────────────── READY ──► download-url (presigned GET)
                                                  │
DELETE /documents/:id (any live state) ─────────► DELETED (deleted_at set; row + object retained)
```

- `upload-url` validates the declaration (allow-listed MIME type, size
  `1..MAX_DOCUMENT_FILE_SIZE_BYTES`, sanitised name, extension/MIME
  consistency for well-known extensions), writes key/type/size/name and
  `UPLOADING` with a conditional `updateMany` (status in DRAFT/UPLOADING/
  FAILED) so concurrent calls cannot interleave, then signs the URL.
- `upload-complete` never trusts the client: it `HEAD`s the object and
  compares size (exact), size limit, content type (normalised) and optional
  ETag against the declaration. Only a matching object flips the row to
  `READY`, again conditionally on `status = UPLOADING AND storage_key = <key>`
  so a concurrent `upload-url` that changed the key cannot be completed by a
  stale request.
- `download-url` requires `READY`, a key and a type; it signs a `GET` with
  the stored content type and an `attachment` disposition for
  `S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS` (default 300 s, max 900 s).
- Soft delete sets `deleted_at` and `status = DELETED` in one conditional
  update; every other read filters `deleted_at IS NULL`, so the file becomes
  unreachable through the API instantly. The object itself is retained for a
  later clean-up/retention job (Phase 2 has no hard delete and no recovery).
- `READY` documents refuse a new upload (`409 INVALID_UPLOAD`) so a file can
  never be silently replaced; the client creates a new document.

Storage also enforces the declaration independently: because `Content-Type`
and `Content-Length` are signed, a `PUT` with a different type or size is
rejected by the object store with `403` before any verification runs.

### Folder hierarchy

Folders are a per-user adjacency list (`parent_id`). Hierarchy mutations
(`create` with a parent, `update` with a new parent, `delete`) run inside a
transaction that first takes a per-user Postgres advisory lock
(`pg_advisory_xact_lock(2001, hashtext(user_id))`), so two concurrent moves
cannot form a cycle between them. Inside the lock:

- the ancestor chain of the new parent is loaded with a recursive CTE;
  `parent == self` → `400 INVALID_FOLDER`, `self ∈ ancestors(parent)` →
  `400 FOLDER_CYCLE_DETECTED`;
- the subtree height of the moved folder plus the parent depth must stay
  within `MAX_FOLDER_DEPTH = 10` → otherwise `400 FOLDER_DEPTH_EXCEEDED`;
- delete moves the folder's documents to the root (`folder_id = NULL`),
  re-parents its direct children to its own parent and then deletes the row.
  Nothing cascades and no content is lost; the response reports
  `movedDocuments` / `promotedFolders`.

All referenced folders (`parentId`, `folderId`, list filters) are resolved
with the owner scope, so a foreign folder id behaves as non-existent.

### Security events

Phase 2 adds `DOCUMENT_CREATED/UPDATED/DELETED`, `DOCUMENT_ACCESS_DENIED`,
`FOLDER_CREATED/UPDATED/DELETED`, `FOLDER_ACCESS_DENIED`,
`UPLOAD_URL_CREATED`, `UPLOAD_COMPLETED`, `UPLOAD_REJECTED` and
`DOWNLOAD_URL_CREATED`. Events carry `userId`, `requestId`, `ip`, resource
ids, sizes/types and a reason; **never** presigned URLs, signatures, storage
keys, credentials, file names or tokens.

### Phase 2 configuration

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `STORAGE_PROVIDER` | Provider id (`s3`) | `s3` |
| `S3_ENDPOINT` | Endpoint the API uses | required (compose: `http://storage:9000`) |
| `S3_PUBLIC_ENDPOINT` | Endpoint signed into presigned URLs; must be reachable by clients | `S3_ENDPOINT` |
| `S3_REGION` | SigV4 region | `us-east-1` |
| `S3_BUCKET` / `TEST_S3_BUCKET` | Private bucket (tests refuse to run against the dev bucket) | required / `<bucket>-test` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Storage credentials; placeholders rejected, dev credentials refused in production | required |
| `S3_FORCE_PATH_STYLE` | Path-style URLs (needed by MinIO/RustFS) | `true` |
| `S3_PRESIGNED_UPLOAD_EXPIRES_SECONDS` | Upload URL TTL, 60–3600 | `900` |
| `S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS` | Download URL TTL, 60–900 | `300` |
| `S3_AUTO_CREATE_BUCKET` | Create the bucket on boot if missing | `true` outside production |
| `MAX_DOCUMENT_FILE_SIZE_BYTES` | Upper bound for declared and stored size (1 KiB–5 GiB) | `52428800` |
| `ALLOWED_DOCUMENT_MIME_TYPES` | Comma-separated allowlist | `application/pdf,image/jpeg,image/png,image/webp` |
| `DOCUMENT_PRESIGN_RATE_LIMIT/_WINDOW` | Per-IP limit for `upload-url` / `download-url` | `30` / `60` |

### Extension points for later phases

- `PROCESSING` status and `page_count` are reserved for OCR/AI pipelines; a
  worker can pick up `READY` documents without a schema change.
- Hard deletion / retention: soft-deleted rows keep `storage_key`, so a job
  can `deleteObject` and purge rows after the retention period.
- Sharing / public links would be a separate module issuing their own
  short-lived URLs; nothing in Phase 2 exposes a permanent object URL.
- Alternative storage backends: implement `StorageProvider` and switch the
  factory in `StorageModule`.


## OCR & text extraction architecture (Phase 3)

### Principles

- **Real engines, no fabricated results.** Native PDF text comes from Poppler
  `pdftotext`; recognition comes from a locally installed Tesseract with
  installed trained data. Confidence is only stored when the engine measured
  it.
- **Asynchronous by design.** The HTTP request persists a job and returns
  `202`; a BullMQ worker on the existing Redis does the work. CPU-heavy steps
  (rendering, recognition) run in short-lived subprocesses with hard
  timeouts, so the Node event loop and the API stay responsive.
- **The database is the source of truth.** Queue entries only schedule work.
  Every state transition is a conditional update, every page is an upsert on
  a unique `(job, page)` key, and the terminal status is derived from the
  persisted pages. Duplicate deliveries, concurrent workers and crashes
  therefore cannot corrupt results.
- **Ownership first.** Every endpoint resolves the document through
  `DocumentsService.getOwned` (owner + not soft-deleted) before touching a
  job; job ids are never accepted as authorisation.
- **Bounded everything.** File size, page count, render pixels, DPI, per-page
  and per-document text, per-page and per-job time, concurrency, attempts,
  queued jobs per user and jobs per document are all configured limits with
  conservative defaults.

### Components

| Component | Responsibility |
| --------- | -------------- |
| `OcrController` / `OcrService` | Validate the request, enforce ownership, document state and quotas, apply the duplicate-job policy under a per-document advisory lock, persist the job, enqueue it |
| `OcrJobService` | All `ocr_jobs` / `ocr_pages` persistence: claim, heartbeat, page upsert + counters, finalise, fail/requeue/cancel, reconciliation queries |
| `OcrQueueService` | BullMQ `Queue` on `REDIS_URL` (job id = OCR job id, bounded attempts, exponential backoff, entries removed on completion/failure) |
| `OcrWorkerService` | BullMQ `Worker` (bounded concurrency), the processing algorithm below, graceful shutdown and the reconciler |
| `OcrExtractionService` | Byte-level validation and the per-page pipeline (async generator) |
| `PopplerService` | `pdfinfo` (page count/sizes), `pdftotext` (native text per page), `pdftoppm` (render one page to PNG) |
| `OcrProvider` → `TesseractOcrProvider` | Engine abstraction; the default implementation shells out to `tesseract` and parses `txt` + `tsv` output |
| `OcrLanguagesService` | Advertises only languages that are configured **and** installed; validates request languages |
| `OcrHealthService` | Probes engine, renderer, language data, queue and worker for `/health/ocr` |

### Provider abstraction

```ts
abstract class OcrProvider {
  recognize(input: { imagePath; language; timeoutMs; workDir }): Promise<{ text; confidence: number | null; wordCount }>;
  describe(): Promise<{ name; version; installedLanguages } | null>;
}
```

`OcrModule` binds `OcrProvider` to `TesseractOcrProvider`. Another engine
only needs a new implementation and a one-line change in the module; jobs,
API, persistence and the worker never reference Tesseract directly.
Tesseract is invoked as `tesseract <image> <outbase> -l <langs> --psm 3 txt tsv`
with `OMP_THREAD_LIMIT=1` (concurrency is controlled by the worker, not by
threads inside each subprocess). The mean of word-level `conf` values from
the TSV (level 5 rows, `conf >= 0`, non-blank text) becomes the page
confidence (0–100, two decimals); `null` when no word was recognised.

### Extraction strategy

```
stored object ──► download to job work dir (size-capped stream)
   ──► sniff bytes: %PDF- / PNG / JPEG / RIFF…WEBP  (must match Document.mimeType)
   ├── PDF:  pdfinfo → page count (≤ OCR_MAX_PDF_PAGES), page sizes
   │         pdftotext → native text per page (split on form feed)
   │         for each page in order:
   │           native text usable?  ──yes──► NATIVE_TEXT page (no rendering)
   │                                ──no───► pdftoppm page @ bounded DPI → tesseract → OCR page
   └── image: header dimensions (≤ OCR_MAX_IMAGE_PIXELS) → tesseract on the stored file → page 1
```

**Native-text rule** (deterministic, `tools/text.ts`, unit-tested): a page's
text layer is used when, after collapsing whitespace, it has at least
`OCR_NATIVE_TEXT_MIN_CHARS` (20) characters **and** letters+digits make up at
least `OCR_NATIVE_TEXT_MIN_ALNUM_RATIO` (0.5) of its non-space characters.
Blank pages and symbol-garbage layers (typical of poor scanner OCR layers) go
to OCR; real text never does. A page is either `NATIVE_TEXT` or `OCR`, never
a concatenation, so a page cannot be duplicated. If `pdftotext` fails on a
PDF that `pdfinfo` could parse, all pages fall back to OCR.

**Render DPI**: `min(OCR_RENDER_DPI, floor(sqrt(OCR_MAX_RENDER_PIXELS / pageArea_in²)))`;
pages that would need less than 50 DPI fail with `OCR_PAGE_TOO_LARGE`.
Pages are rendered one at a time to grayscale PNG and deleted right after
recognition, so memory use is bounded by one page.

**Text limits**: each page is cut at `OCR_MAX_TEXT_PER_PAGE` (`truncated:
true`); once the per-document budget `OCR_MAX_TEXT_PER_DOCUMENT` is
exhausted, subsequent pages are stored as `FAILED` /
`OCR_TEXT_LIMIT_EXCEEDED` and the job ends `PARTIAL`. Text is normalised
(NFC, `\n` line endings, control characters removed, blank runs collapsed).

**Temporary files** live in `OCR_TMP_DIR` (default `<os tmp>/docuai-ocr`)
under a per-job `mkdtemp` directory with server-generated names (`input`,
`page-N.png`, `ocr-*.txt|tsv`), mode `0600`, removed in a `finally` block on
success, failure and cancellation. Presigned URLs are never involved: the
worker reads through `StorageProvider.getObjectStream`.

### OCR job lifecycle

```
            ┌────────────── transient failure, attempts left ──────────────┐
            ▼                                                              │
 QUEUED ──claim──► PROCESSING ──all pages ok──► COMPLETED                  │
   │                   │      ──some pages FAILED──► PARTIAL               │
   │                   │      ──no page ok / permanent error──► FAILED ◄───┘ attempts exhausted
   │                   └──document deleted or not READY──► CANCELLED
   └──document deleted or not READY (seen at claim time)──► CANCELLED
```

- Transitions are owned by the worker and the reconciler; clients never set
  a status. `PROCESSING → QUEUED` is the only backwards edge (retry).
- **Claim**: `UPDATE … WHERE status = 'QUEUED' OR (status = 'PROCESSING' AND
  heartbeat_at < now - OCR_STALE_JOB_MS)`; it increments `attempt_count` and
  clears the previous error. A failed claim means another worker holds a
  live claim: the delivery is rejected (BullMQ retries later; by then the
  job is terminal — no-op — or stale — claimable).
- **Heartbeat** every `min(10 s, OCR_STALE_JOB_MS / 3)` while processing and on
  every persisted page, so staleness reliably means "worker died".
- **Progress**: `processed_pages` counts attempted pages (COMPLETED, EMPTY or
  FAILED), capped at `total_pages`; `failed_pages` counts FAILED. Both are
  recomputed from `ocr_pages` inside the same transaction as the page upsert.
- **Finalisation** (only from `PROCESSING`): no FAILED page → `COMPLETED`;
  some → `PARTIAL` (`errorCode` = most common page error); all → `FAILED`.
  `extraction_method` = `NATIVE_TEXT`, `OCR` or `MIXED` from the page methods.
  Results are committed before the status flips, so a `COMPLETED` job always
  has all its pages.
- **Attempts**: `max_attempts = OCR_MAX_RETRIES + 1` (default 3). Transient
  job-level errors (storage, engine/renderer unavailable, interruption)
  requeue the job with exponential backoff until the budget is used, then
  `FAILED`. Permanent errors (`OCR_UNSUPPORTED_FILE_TYPE`,
  `OCR_FILE_TOO_LARGE`, `OCR_PAGE_LIMIT_EXCEEDED`, `OCR_PAGE_TOO_LARGE`,
  `OCR_INVALID_FILE`, `OCR_DOCUMENT_UNAVAILABLE`) fail immediately with a
  BullMQ `UnrecoverableError`. Page-level errors (timeout of one page, engine
  crash on one page, oversized page, text budget) are recorded on the page
  and processing continues.
- **Timeouts**: `OCR_PAGE_TIMEOUT_MS` bounds render + recognition of one page
  (the subprocess group is `SIGKILL`ed); `OCR_JOB_TIMEOUT_MS` bounds one
  attempt — pages not started before the deadline are recorded as `FAILED` /
  `OCR_PROCESSING_TIMEOUT` and the job ends `PARTIAL`.

### Idempotency, duplicates and recovery

- **Duplicate requests**: creation runs inside
  `pg_advisory_xact_lock(3001, hashtext(documentId))`, so concurrent
  `POST /ocr` calls for one document serialise and exactly one job is
  created; the others receive the same job (`200`). Policy: see
  [API_SPEC.md](API_SPEC.md#post-documentsidocr). One active job per document
  at a time; finished jobs for the same language are reused unless
  `forceReprocess`.
- **Versioning / reprocessing**: a reprocess or retry always creates a new
  job; completed jobs and their pages are immutable and kept. The API
  defaults to the latest job and allows older ones via `jobId`.
- **Duplicate deliveries**: the BullMQ job id is the OCR job id (adding twice
  returns the existing entry); the worker ignores terminal jobs and refuses
  jobs with a live claim; pages are upserts.
- **Resume**: a redelivered interrupted job continues after the highest
  persisted page number with the remaining text budget, so finished pages are
  neither reprocessed nor duplicated.
- **Reconciler** (worker instances, at startup and every
  `OCR_RECONCILE_INTERVAL_MS`): (1) `PROCESSING` rows with a stale heartbeat
  are reset to `QUEUED` and re-enqueued (logged as *recovered after worker
  interruption*) or, when out of attempts, failed with
  `OCR_WORKER_INTERRUPTED`; (2) `QUEUED` rows without a pending queue entry
  are enqueued — this also covers the case where the row committed but
  Redis was unreachable when the API tried to enqueue (the API still answers
  `202`, see `OcrService.schedule`). A job can therefore never remain
  `PROCESSING` or `QUEUED` indefinitely.
- **Graceful shutdown**: `main.ts` enables Nest shutdown hooks and the
  container runs Node as PID 1 (`exec node dist/main.js`), so `SIGTERM`
  reaches the process; `OcrWorkerService.onModuleDestroy` calls
  `Worker.close()`, which stops taking new entries and waits for the job in
  flight (every page it finishes is persisted as it goes). Compose grants
  `stop_grace_period: 30s`; a job that needs longer is killed and resumes
  from its last persisted page through the recovery path above.

### Deployment topology

The worker is embedded in the backend process by default
(`OCR_WORKER_ENABLED=true`, `OCR_MAX_CONCURRENCY=1`). For independent scaling
run the same image twice: API instances with `OCR_WORKER_ENABLED=false`
(their `/health/ocr` reports `worker.state: disabled`) and one or more worker
instances with `OCR_WORKER_ENABLED=true`; all share the queue
`OCR_QUEUE_NAME` on the existing Redis. No second Redis or database is added.

### Languages

`OCR_SUPPORTED_LANGUAGES` declares intent; `tesseract --list-langs` declares
reality; only the intersection is advertised and accepted. Missing packs are
logged at boot and listed in `/health/ocr`. Nothing is downloaded at runtime.
The default `OCR_DEFAULT_LANGUAGE=ind+eng` is used when a request omits
`language`. Identifiers are Tesseract codes everywhere (API, database, logs).
Language detection is **not** implemented; callers choose the language.

### Security events and logging

`OCR_JOB_REQUESTED` and `OCR_RETRY_REQUESTED` are recorded with user,
document, job id and language. The worker logs *queued*, *started*, *page
processed* (debug), *completed*, *partially completed*, *failed*,
*requeued*, *resumed*, *recovered* and *re-enqueued by reconciler* with
`ocrJobId`, `documentId`, `userId`, attempt and safe codes. Extracted text,
storage keys, presigned URLs and tool output never reach the logs; subprocess
stderr is reduced to a first-line diagnostic kept in the internal `detail`
of `OcrProcessingError`.

### Phase 3 configuration

See `backend/.env.example`; defaults in parentheses. `OCR_ENABLED` (true),
`OCR_WORKER_ENABLED` (true), `OCR_DEFAULT_LANGUAGE` (`ind+eng`),
`OCR_SUPPORTED_LANGUAGES` (the ten initial codes), `OCR_MAX_LANGUAGES_PER_JOB`
(3), `OCR_QUEUE_NAME` (`docuai-ocr`), `OCR_MAX_CONCURRENCY` (1),
`OCR_MAX_RETRIES` (2), `OCR_RETRY_BACKOFF_MS` (5000), `OCR_JOB_TIMEOUT_MS`
(600000), `OCR_PAGE_TIMEOUT_MS` (60000), `OCR_STALE_JOB_MS` (120000; the
heartbeat fires at least every 10 s, so this bounds how long a crashed
worker's job stays `PROCESSING`),
`OCR_RECONCILE_INTERVAL_MS` (60000), `OCR_MAX_FILE_SIZE_BYTES`
(= `MAX_DOCUMENT_FILE_SIZE_BYTES`, 50 MiB), `OCR_MAX_PDF_PAGES` (100),
`OCR_RENDER_DPI` (150), `OCR_MAX_RENDER_PIXELS` (20 MP), `OCR_MAX_IMAGE_PIXELS`
(25 MP), `OCR_MAX_TEXT_PER_PAGE` (200 000), `OCR_MAX_TEXT_PER_DOCUMENT`
(2 000 000), `OCR_MAX_ACTIVE_JOBS_PER_USER` (5), `OCR_MAX_JOBS_PER_DOCUMENT`
(20), `OCR_NATIVE_TEXT_MIN_CHARS` (20), `OCR_NATIVE_TEXT_MIN_ALNUM_RATIO`
(0.5), `OCR_TESSERACT_PATH`, `OCR_POPPLER_PATH`, `OCR_TESSDATA_PREFIX`,
`OCR_TMP_DIR`, `OCR_REQUEST_RATE_LIMIT` (10), `OCR_REQUEST_RATE_WINDOW` (60).
All values are validated by Joi at boot (ranges, patterns); the app refuses
to start on invalid values. These are initial operating limits for a small
VM, not universal guarantees — raise them with the hardware.

### Known limitations

- OCR quality depends on scan resolution, language choice, fonts and layout;
  no accuracy percentage is promised. Handwriting is not supported.
- Language detection, image enhancement/deskew, rotated-page detection and
  table structure recovery are out of scope.
- Native text extraction follows `pdftotext -layout`; reading order of
  complex multi-column layouts may differ from the visual order.
- Results of QUEUED/PROCESSING jobs are not exposed; clients poll status.
- Soft-deleted documents keep their OCR rows (same retention policy as the
  document itself); hard deletion is a later phase.

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
- **StorageProvider / S3StorageProvider** (global) wraps the S3 SDK; see the
  Phase 2 section above. A missing bucket is created at boot outside
  production; in production the app refuses to start without it.

## Health

`GET /api/v1/health` returns `status`, `database`, `redis`, `storage`, `ocr`,
`uptime` and `timestamp`. Any of database/redis/storage being down yields
`503 SERVICE_UNAVAILABLE`. The Docker healthcheck for the backend calls this
endpoint. `ocr` is an informational summary only; `GET /api/v1/health/ocr`
is the OCR-specific readiness probe (503 `OCR_UNAVAILABLE` when the engine,
renderer, default language data, queue or enabled worker is unavailable), so
a missing language pack degrades OCR without taking the API down.

## Testing strategy

- Unit tests (`src/**/*.spec.ts`) cover pure components: filter, interceptor,
  middleware, configuration (incl. storage/document/OCR config), password
  hashing, token utilities, serializers, security events, file-name
  sanitisation, storage-key generation, the S3 provider (SDK mocked), file
  signature / image-dimension parsing, the native-text rule, TSV confidence
  parsing, the subprocess runner (real timeout kill) and the Tesseract
  provider against the real engine (recognition, timeout, undecodable image).
- e2e tests (`test/**/*.e2e-spec.ts`) boot the real `AppModule` through
  `configureApp()` – the exact production pipeline – against the isolated
  test database (`TEST_DATABASE_URL`), Redis db index 1 and a **real**
  S3-compatible store using a dedicated test bucket (`TEST_S3_BUCKET`,
  must differ from `S3_BUCKET`). They cover registration, login, JWT
  validation, refresh rotation, reuse detection, concurrency, logout,
  profile, forbidden fields, rate limiting, folder CRUD / cycles / depth /
  transactional delete, document CRUD / pagination / search / sort / soft
  delete, the full presigned upload → verify → download round trip (including
  size and type mismatches, fake completions, oversized and zero-byte
  declarations, path-traversal names), an explicit IDOR matrix (user A × user
  B × every document and folder endpoint) and log hygiene (a capturing logger
  asserts no password/token/hash/presigned URL ever reaches the log).
  Phase 3 adds three OCR suites that run the **real** Tesseract + Poppler
  pipeline through the HTTP API and the embedded BullMQ worker on committed
  fixtures (`test/fixtures/ocr`, regenerated deterministically by
  `generate.mjs`): native/multi-page/long/scanned/mixed PDFs, PNG/JPEG/WebP,
  blank, corrupt and MIME-spoofed files, page/text limits; the OCR IDOR
  matrix, document-state rules, DTO validation, duplicate and concurrent
  requests, `forceReprocess`, quotas, pagination and retry rules; and
  lifecycle tests with a manually driven worker (duplicate and concurrent
  delivery, partial failure, bounded retries, timeouts, cancellation,
  interrupted-job recovery with resume, stale-job failure, enqueue-failure
  reconciliation). OCR assertions compare normalised text and required
  keywords rather than exact bytes.
- `test/global-setup.ts` runs `prisma migrate deploy` on the test database.
  No test ever drops or resets a database or touches the development bucket.

## Containers

`docker-compose.yml` defines `postgres` (named volume, init script creating the
`*_test` database), `redis` (AOF persistence, named volume), `storage`
(RustFS, an S3-compatible object store; named volume `storage_data`,
`/health` healthcheck, S3 port published on `127.0.0.1` only, admin console
not published, root credentials from `STORAGE_ACCESS_KEY` /
`STORAGE_SECRET_KEY`) and `backend` (built from `backend/Dockerfile`, runs
`prisma migrate deploy` before starting). All dependencies have healthchecks
and the backend waits for them.

The backend image (Debian bookworm) installs `tesseract-ocr` with the ten
language packs (`tesseract-ocr-{ind,eng,msa,ara,chi-sim,jpn,kor,deu,fra,spa}`)
and `poppler-utils`; the build fails if `tesseract --list-langs` or
`pdftoppm -v` do not run. No host-installed OCR binaries are relied upon. The
embedded OCR worker starts and stops with the container: Node runs as PID 1
and `stop_grace_period: 30s` gives the job in flight time to finish; longer
jobs resume from their last persisted page after the restart.

RustFS is used instead of MinIO because the MinIO community image is no longer
published; the backend only speaks the S3 API, so any S3-compatible service
can replace it by changing `S3_*` variables. The storage service in compose is
a development convenience: production deployments should use a managed or
hardened S3-compatible service behind TLS and set `S3_PUBLIC_ENDPOINT` to the
host clients reach.
