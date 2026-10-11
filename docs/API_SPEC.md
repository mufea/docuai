# DocuAI API Specification

Base URL: `http://<host>:4310/api/v1`

Interactive OpenAPI documentation: `GET /api/v1/docs` (enabled outside
production, or when `SWAGGER_ENABLED=true`). Use the **Authorize** button with
an access token to call protected endpoints.

## Conventions

### Response envelope

Success:

```json
{
  "success": true,
  "data": {},
  "message": null,
  "requestId": "0b1e9c4e-2c5a-4a0b-9c8b-6c2e6f1c9d21"
}
```

Error:

```json
{
  "success": false,
  "data": null,
  "code": "ERROR_CODE",
  "message": "Human readable description",
  "requestId": "0b1e9c4e-2c5a-4a0b-9c8b-6c2e6f1c9d21"
}
```

Clients must branch on `code`, never on `message`.

### Request ID

Every response carries `X-Request-Id`. Clients may send their own
`X-Request-Id` (`[A-Za-z0-9._:-]{1,128}`) to correlate logs; otherwise a UUID
is generated.

### Authentication

Protected endpoints require an access token:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived JWTs (default 15 minutes, `expiresIn` in the
response tells the client the lifetime in seconds). When one expires the client
calls `POST /auth/refresh` with its refresh token and receives a **new** access
token **and a new refresh token**; the old refresh token is invalid from that
moment on. Clients must serialise refresh calls: two concurrent refreshes with
the same token are treated as token reuse and terminate every session of the
user.

| Route | Auth |
| ----- | ---- |
| `GET /health` | public |
| `POST /auth/register` | public |
| `POST /auth/login` | public |
| `POST /auth/refresh` | public |
| `POST /auth/logout` | bearer |
| `GET /auth/me` | bearer |
| `GET /users/me` | bearer |
| `PATCH /users/me` | bearer |
| `POST /folders` | bearer |
| `GET /folders` | bearer |
| `GET /folders/:id` | bearer |
| `PATCH /folders/:id` | bearer |
| `DELETE /folders/:id` | bearer |
| `POST /documents` | bearer |
| `GET /documents` | bearer |
| `GET /documents/:id` | bearer |
| `PATCH /documents/:id` | bearer |
| `DELETE /documents/:id` | bearer |
| `POST /documents/:id/upload-url` | bearer |
| `POST /documents/:id/upload-complete` | bearer |
| `GET /documents/:id/download-url` | bearer |

Document and folder endpoints additionally load the account on every call
(`ActiveUserGuard`), so a suspended or deleted account is refused
immediately (`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`) even while
its access token is still technically valid.

### Ownership

Every document and folder belongs to exactly one user — the authenticated
caller. The owner is always derived from the access token; a `userId` in a
request body is rejected as an unknown property. All reads and writes are
scoped to the caller, so a resource that does not exist, has been
soft-deleted or **belongs to someone else** yields the same
`404 DOCUMENT_NOT_FOUND` / `404 FOLDER_NOT_FOUND`. The API never confirms
that a foreign id exists.

Path ids must be UUIDs; anything else is `400 VALIDATION_ERROR`.

### Validation

Request bodies are validated strictly. Unknown fields are rejected:

```json
{ "success": false, "data": null, "code": "VALIDATION_ERROR", "message": "property foo should not exist", "requestId": "..." }
```

Emails are trimmed and lower-cased before use. Passwords are never modified
(no trimming) and must be 8–128 characters.

### Rate limiting

All endpoints (except `/health`) share a per-IP limit of `THROTTLE_LIMIT`
requests per `THROTTLE_TTL` seconds. Authentication endpoints additionally
have their own, stricter per-IP buckets:

| Endpoint | Default | Variables |
| -------- | ------- | --------- |
| `POST /auth/login` | 10 / 60 s | `AUTH_LOGIN_RATE_LIMIT`, `AUTH_LOGIN_RATE_WINDOW` |
| `POST /auth/register` | 5 / 60 s | `AUTH_REGISTER_RATE_LIMIT`, `AUTH_REGISTER_RATE_WINDOW` |
| `POST /auth/refresh` | 20 / 60 s | `AUTH_REFRESH_RATE_LIMIT`, `AUTH_REFRESH_RATE_WINDOW` |
| `POST /documents/:id/upload-url` | 30 / 60 s | `DOCUMENT_PRESIGN_RATE_LIMIT`, `DOCUMENT_PRESIGN_RATE_WINDOW` |
| `GET /documents/:id/download-url` | 30 / 60 s | `DOCUMENT_PRESIGN_RATE_LIMIT`, `DOCUMENT_PRESIGN_RATE_WINDOW` |
| `POST /documents/:id/ocr` | 10 / 60 s | `OCR_REQUEST_RATE_LIMIT`, `OCR_REQUEST_RATE_WINDOW` |
| `POST /documents/:id/ocr/retry` | 10 / 60 s | `OCR_REQUEST_RATE_LIMIT`, `OCR_REQUEST_RATE_WINDOW` |

Exceeding a limit returns `429 RATE_LIMITED` with a `Retry-After` header.

### Error codes

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `VALIDATION_ERROR` | 400 | Request body/query failed validation |
| `BAD_REQUEST` | 400 | Malformed request (e.g. invalid JSON) |
| `UNAUTHORIZED` | 401 | Generic unauthenticated (non-auth modules) |
| `AUTH_UNAUTHORIZED` | 401 | No bearer token, or token subject no longer exists |
| `AUTH_INVALID_TOKEN` | 401 | Access token malformed, expired or badly signed |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email or password (deliberately indistinguishable) |
| `AUTH_REFRESH_TOKEN_INVALID` | 401 | Refresh token unknown or malformed |
| `AUTH_REFRESH_TOKEN_EXPIRED` | 401 | Refresh token past `expiresAt` |
| `AUTH_REFRESH_TOKEN_REUSED` | 401 | Refresh token already revoked/rotated; all sessions were revoked |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Credentials valid but account suspended |
| `AUTH_ACCOUNT_DELETED` | 403 | Credentials valid but account deleted |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Route or resource not found |
| `USER_NOT_FOUND` | 404 | Profile update for a user that no longer exists |
| `DOCUMENT_NOT_FOUND` | 404 | Document unknown, soft-deleted **or owned by another user** |
| `FOLDER_NOT_FOUND` | 404 | Folder unknown **or owned by another user** (also for `folderId` / `parentId` references) |
| `INVALID_FOLDER` | 400 | Invalid hierarchy change, e.g. a folder set as its own parent |
| `FOLDER_CYCLE_DETECTED` | 400 | Moving a folder inside one of its own descendants |
| `FOLDER_DEPTH_EXCEEDED` | 400 | Nesting deeper than 10 levels |
| `AUTH_EMAIL_ALREADY_EXISTS` | 409 | Registration with an email already in use |
| `INVALID_UPLOAD` | 409 | Upload operation not allowed in the document's current state, or the stored object contradicts the declaration (document becomes `FAILED`) |
| `UPLOAD_NOT_FOUND` | 409 | `upload-complete` called but no object exists under the document's storage key |
| `UPLOAD_NOT_READY` | 409 | `download-url` requested for a document without a completed upload |
| `CONFLICT` | 409 | Other state conflict |
| `FILE_TOO_LARGE` | 413 | Declared `fileSize` above `MAX_DOCUMENT_FILE_SIZE_BYTES` |
| `UNSUPPORTED_FILE_TYPE` | 415 | `contentType` outside the allowlist, or a well-known extension that contradicts it |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error (details are logged, never returned) |
| `SERVICE_UNAVAILABLE` | 503 | A dependency (database, Redis, object storage) is down |
| `STORAGE_ERROR` | 503 | The object storage call failed; retry later. Provider details are logged, never returned |

OCR error codes (Phase 3). Codes marked *job* also appear in `OcrJob.errorCode`
/ `OcrPage.errorCode` as the recorded outcome of asynchronous processing;
codes marked **permanent** describe the input itself and are never retried
automatically (the retry endpoint refuses them too).

| Code | HTTP | Job | Meaning |
| ---- | ---- | --- | ------- |
| `OCR_NOT_FOUND` | 404 | | No OCR job exists for this document (or `jobId` does not belong to it) |
| `OCR_NOT_READY` | 409 | | Results requested while the latest job is `QUEUED` / `PROCESSING` |
| `OCR_DOCUMENT_NOT_READY` | 409 | | Document is not `READY` (no verified upload) |
| `OCR_ALREADY_PROCESSING` | 409 | | A job with a *different* language is active for the document |
| `OCR_RETRY_NOT_ALLOWED` | 409 | | Latest job is not `FAILED`/`PARTIAL`, or failed permanently |
| `OCR_UNSUPPORTED_LANGUAGE` | 400 | | Language not installed/configured; the message lists the available codes |
| `OCR_UNSUPPORTED_FILE_TYPE` | 415 | job, **permanent** | Document type not PDF/JPEG/PNG/WebP, or the stored bytes do not match the declared type |
| `OCR_FILE_TOO_LARGE` | 413 | job, **permanent** | Above `OCR_MAX_FILE_SIZE_BYTES` (defaults to the upload limit) |
| `OCR_PAGE_LIMIT_EXCEEDED` | 413 | job, **permanent** | PDF has more than `OCR_MAX_PDF_PAGES` pages |
| `OCR_PAGE_TOO_LARGE` | — | job/page, **permanent** | Image or page exceeds the pixel budget |
| `OCR_INVALID_FILE` | — | job/page, **permanent** | File cannot be parsed/decoded (corrupt PDF or image) |
| `OCR_TEXT_LIMIT_EXCEEDED` | — | job/page | Document text limit reached; later pages were not stored |
| `OCR_PROCESSING_TIMEOUT` | — | job/page | Page or job exceeded its time budget (retryable) |
| `OCR_PROCESSING_FAILED` | — | job/page | Engine/renderer failure (retryable) |
| `OCR_STORAGE_ERROR` | — | job | The stored file could not be read (retryable; permanent when the object is missing) |
| `OCR_WORKER_INTERRUPTED` | — | job | Worker died mid-job and the attempt budget is exhausted |
| `OCR_DOCUMENT_UNAVAILABLE` | — | job (`CANCELLED`) | Document was deleted / left `READY` before processing |
| `OCR_TOO_MANY_JOBS` | 429 | | Per-user active-job or per-document job quota reached |
| `OCR_UNAVAILABLE` | 503 | | `OCR_ENABLED=false`, or `/health/ocr` found a dependency missing |

## Schemas

### `User` (public representation)

Returned everywhere a user appears. `passwordHash` is never included.

```json
{
  "id": "70ce2001-72d7-4b28-8500-a0054b417437",
  "email": "user@example.com",
  "name": "John Doe",
  "avatarUrl": null,
  "status": "ACTIVE",
  "emailVerified": false,
  "createdAt": "2026-09-12T12:45:58.817Z",
  "updatedAt": "2026-09-12T12:45:58.817Z"
}
```

`status` ∈ `ACTIVE | SUSPENDED | DELETED`.

### `TokenPair`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "OMFiqaV6n2nBpCduoQyofW-7tYqv78Y1Gk6v3-jWEhY0T7v89qEePBVvzFVD5O-K",
  "expiresIn": 900,
  "tokenType": "Bearer"
}
```

### `AuthResponse`

`TokenPair` plus `"user": User`.

### `Folder`

```json
{
  "id": "5c81becc-fe95-4d54-9824-d446bae7c39b",
  "name": "Invoices",
  "parentId": null,
  "createdAt": "2026-10-09T03:36:56.000Z",
  "updatedAt": "2026-10-09T03:36:56.000Z"
}
```

`userId` is never included (the caller is always the owner).

### `Document`

```json
{
  "id": "f635f364-dabe-41c7-8ece-ffaf354e6502",
  "folderId": "5c81becc-fe95-4d54-9824-d446bae7c39b",
  "title": "Invoice March",
  "description": "Smoke test",
  "status": "READY",
  "mimeType": "application/pdf",
  "fileSize": 2030,
  "pageCount": null,
  "originalName": "invoice märz.pdf",
  "createdAt": "2026-10-09T03:36:56.000Z",
  "updatedAt": "2026-10-09T03:36:58.000Z"
}
```

`status` ∈ `DRAFT | UPLOADING | READY | PROCESSING | FAILED | DELETED`:

| Status | Meaning |
| ------ | ------- |
| `DRAFT` | Metadata created, no upload requested yet |
| `UPLOADING` | An upload URL was issued; the client is expected to PUT the file |
| `READY` | The object was verified in storage; the document can be downloaded |
| `PROCESSING` | Reserved for a later phase (OCR/AI); never set in Phase 2 |
| `FAILED` | The uploaded object contradicted the declaration; request a new upload URL |
| `DELETED` | Soft-deleted; only ever visible in the `DELETE` response |

`mimeType`, `fileSize` and `originalName` are `null` until an upload URL has
been requested. `fileSize` is the client's declaration while `UPLOADING` and
the verified size from `READY` on. `pageCount` is reserved and always `null`.
`userId`, `storageKey` and `deletedAt` are internal and never returned.

### `OcrJob`

```json
{
  "id": "uuid",
  "documentId": "uuid",
  "status": "COMPLETED",
  "language": "ind+eng",
  "extractionMethod": "MIXED",
  "totalPages": 3,
  "processedPages": 3,
  "failedPages": 0,
  "progress": 100,
  "attemptCount": 1,
  "maxAttempts": 3,
  "errorCode": null,
  "errorMessage": null,
  "createdAt": "2026-10-09T06:00:00.000Z",
  "startedAt": "2026-10-09T06:00:01.000Z",
  "completedAt": "2026-10-09T06:00:04.000Z",
  "updatedAt": "2026-10-09T06:00:04.000Z"
}
```

- `status`: `QUEUED | PROCESSING | COMPLETED | PARTIAL | FAILED | CANCELLED`
  (see [ARCHITECTURE.md](ARCHITECTURE.md#ocr-job-lifecycle)).
- `language`: canonical Tesseract code list, `+`-separated in priority order.
- `extractionMethod`: `NATIVE_TEXT` (all pages from the PDF text layer),
  `OCR` (all pages recognised), `MIXED`; `null` until the first page is done.
- `processedPages` counts **attempted** pages (completed, empty or failed);
  `progress` = `processedPages / totalPages` in percent, `null` until the
  page count is known. `processedPages` never exceeds `totalPages`.
- `errorCode` / `errorMessage` are safe codes/texts from the table above;
  never paths, tool output or stack traces.

### `OcrPage`

```json
{
  "pageNumber": 2,
  "status": "COMPLETED",
  "method": "OCR",
  "text": "Scanned page two\nSECOND SHEET",
  "confidence": 93.71,
  "charCount": 29,
  "truncated": false,
  "errorCode": null
}
```

- `pageNumber` is 1-based and matches the document's page order; an image is
  page 1.
- `status`: `COMPLETED` (text extracted), `EMPTY` (processed, no text found;
  `text` is `""`), `FAILED` (`text` is `null`, `errorCode` set).
- `method`: `NATIVE_TEXT` or `OCR` — a page is never both.
- `confidence`: mean Tesseract word confidence, 0–100, two decimals. `null`
  for native text (not an OCR measurement) and when no word was recognised.
  It is an engine heuristic, not an accuracy guarantee.
- `truncated`: `true` when `text` was cut at `OCR_MAX_TEXT_PER_PAGE` or at the
  remaining document budget (`OCR_MAX_TEXT_PER_DOCUMENT`).

### `Pagination`

```json
{ "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
```

## Endpoints

### Health

#### `GET /health`

Public. Excluded from rate limiting.

Response `200`:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "database": "up",
    "redis": "up",
    "storage": "up",
    "uptime": 128,
    "timestamp": "2026-09-12T12:00:00.000Z"
  },
  "message": null,
  "requestId": "..."
}
```

Response `503` when any dependency is down:

```json
{ "success": false, "data": null, "code": "SERVICE_UNAVAILABLE", "message": "Dependencies unavailable: redis", "requestId": "..." }
```

`storage` reflects a `HeadBucket` call against the configured private bucket.
`ocr` (Phase 3) is an informational summary — `ready`, `degraded` or
`disabled` — and never affects `status`; OCR problems therefore never fail
unrelated requests or the container health check.

#### `GET /health/ocr`

Public. Excluded from rate limiting. OCR-specific readiness.

Response `200`:

```json
{
  "status": "ready",
  "enabled": true,
  "engine": { "available": true, "name": "tesseract", "version": "5.3.0" },
  "renderer": { "available": true, "name": "poppler", "version": "22.12.0" },
  "languages": {
    "default": "ind+eng",
    "defaultAvailable": true,
    "available": ["ind", "eng", "msa", "ara", "chi_sim", "jpn", "kor", "deu", "fra", "spa"],
    "missing": []
  },
  "queue": { "status": "up", "name": "docuai-ocr", "counts": { "waiting": 0, "active": 0, "delayed": 0, "prioritized": 0, "failed": 0 } },
  "worker": { "state": "running", "concurrency": 1 },
  "timestamp": "2026-10-09T06:00:00.000Z"
}
```

`languages.available` lists only codes that are both configured
(`OCR_SUPPORTED_LANGUAGES`) **and** installed for the engine; `missing` lists
configured codes without trained data. `worker.state` is `running`,
`disabled` (`OCR_WORKER_ENABLED=false` — API-only instance), `starting` or
`stopped`.

Response `503 OCR_UNAVAILABLE` when OCR is enabled but the engine, renderer,
default language data, queue or (enabled) worker is unavailable; the message
names the missing parts. `200` with `status: "disabled"` when
`OCR_ENABLED=false`.

### Auth

#### `POST /auth/register`

Public. Rate limit: register bucket.

Request:

```json
{
  "email": "user@example.com",
  "password": "strong-password",
  "name": "John Doe",
  "deviceName": "Pixel 8"
}
```

| Field | Rules |
| ----- | ----- |
| `email` | required, valid email, ≤ 320 chars, normalised |
| `password` | required, string, 8–128 chars, stored only as Argon2id hash |
| `name` | optional, 1–100 chars, trimmed |
| `deviceName` | optional, 1–100 chars, label for this session |

Response `201`: `AuthResponse`. The account is created, a session (refresh
token) is opened and an access token is issued in one step.

Errors: `400 VALIDATION_ERROR`, `409 AUTH_EMAIL_ALREADY_EXISTS`,
`429 RATE_LIMITED`.

#### `POST /auth/login`

Public. Rate limit: login bucket.

Request:

```json
{ "email": "user@example.com", "password": "strong-password", "deviceName": "Pixel 8" }
```

Response `200`: `AuthResponse`. Each login creates an additional session; other
devices stay signed in.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_INVALID_CREDENTIALS` (unknown email
and wrong password are indistinguishable), `403 AUTH_ACCOUNT_SUSPENDED`,
`403 AUTH_ACCOUNT_DELETED` (only after the password matched),
`429 RATE_LIMITED`.

#### `POST /auth/refresh`

Public. Rate limit: refresh bucket.

Request:

```json
{ "refreshToken": "OMFiqaV6n2nBpCduoQyofW-7tYqv78Y1Gk6v3-jWEhY0T7v89qEePBVvzFVD5O-K" }
```

Response `200`: `TokenPair` with a **new** refresh token. The presented token
is revoked atomically; replace it on the client immediately.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_REFRESH_TOKEN_INVALID`,
`401 AUTH_REFRESH_TOKEN_EXPIRED`, `401 AUTH_REFRESH_TOKEN_REUSED` (the token
was already used or revoked — **all** of the user's sessions have now been
revoked and the user must log in again), `403 AUTH_ACCOUNT_SUSPENDED`,
`403 AUTH_ACCOUNT_DELETED`, `429 RATE_LIMITED`.

#### `POST /auth/logout`

Bearer required.

Request:

```json
{ "refreshToken": "..." }
```

Response `200`:

```json
{ "success": true, "data": null, "message": "Logged out", "requestId": "..." }
```

Revokes only the presented session. Idempotent: an unknown, already revoked
or foreign refresh token yields the same `200` so the endpoint cannot be used
to probe token state. The access token remains technically valid until it
expires (≤ 15 minutes); clients must discard it.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`.

#### `GET /auth/me`

Bearer required. Response `200`: `User`.

Errors: `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`,
`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`.

### Users

#### `GET /users/me`

Bearer required. Same response and errors as `GET /auth/me`.

#### `PATCH /users/me`

Bearer required.

Request (all fields optional; `null` clears a field):

```json
{ "name": "Updated User", "avatarUrl": "https://cdn.example.com/avatars/me.png" }
```

| Field | Rules |
| ----- | ----- |
| `name` | string 1–100 chars (trimmed) or `null` |
| `avatarUrl` | absolute `http(s)` URL ≤ 2048 chars or `null` |

Any other property (`email`, `status`, `emailVerified`, `passwordHash`, `id`,
`createdAt`, `updatedAt`, …) is rejected with `400 VALIDATION_ERROR`
(`property <name> should not exist`). Email changes will arrive with email
verification in a later phase.

Response `200`: updated `User`.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`,
`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`, `404 USER_NOT_FOUND`.

### Folders

Folders form a per-user tree (at most 10 levels deep). All endpoints require a
bearer token and are subject to the ownership rules above. Common errors for
every folder endpoint: `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`,
`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`.

#### `POST /folders`

Request:

```json
{ "name": "Invoices", "parentId": null }
```

| Field | Rules |
| ----- | ----- |
| `name` | required, 1–100 chars, trimmed, no control characters |
| `parentId` | optional UUID of one of the caller's folders, or `null`/omitted for a root folder |

Response `201`: `Folder`.

Errors: `400 VALIDATION_ERROR`, `400 FOLDER_DEPTH_EXCEEDED`,
`404 FOLDER_NOT_FOUND` (parent unknown or foreign).

#### `GET /folders`

Query `parentId`: omit for **all** of the caller's folders, `null` for root
folders only, or a folder id for its direct children.

Response `200`: `Folder[]` ordered by name.

Errors: `400 VALIDATION_ERROR`, `404 FOLDER_NOT_FOUND` (filter folder unknown
or foreign).

#### `GET /folders/:id`

Response `200`: `Folder`. Errors: `404 FOLDER_NOT_FOUND`.

#### `PATCH /folders/:id`

Request (all optional):

```json
{ "name": "Invoices 2026", "parentId": "b5e9…" }
```

`parentId: null` moves the folder to the root. Any other property (`userId`,
`id`, timestamps) is rejected with `400 VALIDATION_ERROR`.

Response `200`: updated `Folder`.

Errors: `400 VALIDATION_ERROR`, `400 INVALID_FOLDER` (self-parent),
`400 FOLDER_CYCLE_DETECTED` (new parent is the folder itself or one of its
descendants), `400 FOLDER_DEPTH_EXCEEDED` (the moved subtree would exceed 10
levels), `404 FOLDER_NOT_FOUND` (folder or new parent unknown / foreign).

#### `DELETE /folders/:id`

Deletes the folder in one transaction:

- documents directly inside it are moved to the root (`folderId = null`);
- direct child folders are re-parented to the deleted folder's parent (so
  no content is ever lost and nothing cascades).

Response `200`:

```json
{ "success": true, "data": { "id": "…", "movedDocuments": 3, "promotedFolders": 1 }, "message": "Folder deleted", "requestId": "…" }
```

Errors: `404 FOLDER_NOT_FOUND` (also for a second delete).

### Documents

A document is metadata plus, once uploaded, exactly one file. Files never
flow through the API: the client uploads to and downloads from object
storage using **short-lived presigned URLs** issued by the API. Common errors
for every document endpoint: `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`,
`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`, `404 DOCUMENT_NOT_FOUND`
(unknown, deleted or foreign id).

#### Upload / download flow

```
POST /documents                         → DRAFT
POST /documents/:id/upload-url          → UPLOADING, returns presigned PUT + required headers
PUT  <uploadUrl>  (directly to storage, body = raw file, headers verbatim)
POST /documents/:id/upload-complete     → server verifies the object (size, type) → READY
GET  /documents/:id/download-url        → presigned GET (READY only)
GET  <downloadUrl> (directly from storage)
DELETE /documents/:id                   → soft delete, file unreachable
```

#### `POST /documents`

Request:

```json
{ "title": "Invoice March", "description": "Scanned at home", "folderId": null }
```

| Field | Rules |
| ----- | ----- |
| `title` | required, 1–255 chars, trimmed, no control characters |
| `description` | optional, ≤ 2000 chars, line breaks allowed, or `null` |
| `folderId` | optional UUID of one of the caller's folders, or `null` for the root |

Response `201`: `Document` with `status: "DRAFT"`. Properties such as
`userId`, `status`, `storageKey`, `mimeType` or `fileSize` are rejected with
`400 VALIDATION_ERROR`.

Errors: `400 VALIDATION_ERROR`, `404 FOLDER_NOT_FOUND`.

#### `GET /documents`

Query parameters (all optional):

| Param | Rules | Default |
| ----- | ----- | ------- |
| `page` | integer ≥ 1 | `1` |
| `limit` | integer 1–100 | `20` |
| `folderId` | omit = all folders, `null` = root only, or a folder id (must be the caller's) | – |
| `status` | `DRAFT | UPLOADING | READY | PROCESSING | FAILED` (`DELETED` is not accepted) | – |
| `search` | ≤ 200 chars, case-insensitive substring match on `title` and `description` | – |
| `sort` | `createdAt | updatedAt | title | fileSize` | `createdAt` |
| `order` | `asc | desc` | `desc` |

Response `200`:

```json
{ "items": [ Document, … ], "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 } }
```

Soft-deleted documents are never listed. Ordering uses `id` as a stable
tie-breaker so pages never overlap.

Errors: `400 VALIDATION_ERROR`, `404 FOLDER_NOT_FOUND`.

#### `GET /documents/:id`

Response `200`: `Document`.

#### `PATCH /documents/:id`

Request (all optional; `folderId: null` moves to the root, `description: null`
clears it):

```json
{ "title": "Invoice March (final)", "description": null, "folderId": null }
```

Only `title`, `description` and `folderId` are editable. Everything else
(`status`, `mimeType`, `fileSize`, `storageKey`, `userId`, …) is rejected
with `400 VALIDATION_ERROR`; file properties change only through the upload
flow.

Response `200`: updated `Document`.

Errors: `400 VALIDATION_ERROR`, `404 DOCUMENT_NOT_FOUND | FOLDER_NOT_FOUND`.

#### `DELETE /documents/:id`

Soft delete: the document gets `deletedAt` and `status = DELETED` and
disappears from every other endpoint; its file can no longer be downloaded
(existing presigned URLs expire within their TTL). There is no recovery
endpoint in Phase 2.

Response `200`:

```json
{ "success": true, "data": { "id": "…", "status": "DELETED", "deletedAt": "…" }, "message": "Document deleted", "requestId": "…" }
```

Not idempotent: a second delete yields `404 DOCUMENT_NOT_FOUND`.

#### `POST /documents/:id/upload-url`

Rate limit: presign bucket. Declares the file and returns a presigned PUT.

Request:

```json
{ "fileName": "invoice.pdf", "contentType": "application/pdf", "fileSize": 2030 }
```

| Field | Rules |
| ----- | ----- |
| `fileName` | required, 1–255 chars, no control characters. Used **only** for display and the download file name: path components are stripped (`../../etc/x.pdf` → `x.pdf`), reserved characters removed, Unicode normalised. Never used as a storage key. |
| `contentType` | required MIME type; must be in `ALLOWED_DOCUMENT_MIME_TYPES` (default `application/pdf, image/jpeg, image/png, image/webp`). Parameters (`; charset=`) are dropped, case is normalised. A well-known extension (`.pdf .jpg .jpeg .png .webp`) that contradicts it is rejected. |
| `fileSize` | required integer ≥ 1 and ≤ `MAX_DOCUMENT_FILE_SIZE_BYTES` (default 50 MiB). Zero and negative sizes are rejected. |

Allowed from `DRAFT`, `UPLOADING` (re-request before the first PUT; the
previous URL/key is invalidated) and `FAILED`. A `READY` document refuses new
uploads (`409 INVALID_UPLOAD`) — create a new document instead.

Response `200`:

```json
{
  "uploadUrl": "http://localhost:9000/docuai-private/users/…/documents/…/…?X-Amz-Algorithm=…",
  "method": "PUT",
  "headers": { "Content-Type": "application/pdf", "Content-Length": "2030" },
  "expiresAt": "2026-10-09T03:51:56.000Z",
  "expiresInSeconds": 900,
  "document": { "…": "Document with status UPLOADING" }
}
```

The client must `PUT` the raw file body to `uploadUrl` with exactly the
returned `headers`: `Content-Type` and `Content-Length` are part of the
signature, so storage itself rejects (`403`) a body of a different size or a
different declared type. The storage key is generated by the server
(`users/{userId}/documents/{documentId}/{random}`) and is never exposed.

Errors: `400 VALIDATION_ERROR`, `404 DOCUMENT_NOT_FOUND`,
`409 INVALID_UPLOAD`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`,
`429 RATE_LIMITED`, `503 STORAGE_ERROR`.

#### `POST /documents/:id/upload-complete`

Request (body may be `{}`):

```json
{ "etag": "\"9bb58f26192e4ba00f01e2e7b136bbd8\"" }
```

The server performs a `HEAD` on the object under the document's storage key
and verifies that it exists, its size equals the declared `fileSize` and is
within the limit, and its content type equals the declared, allow-listed
type (and the ETag, if one was supplied). On success the document becomes
`READY`. On a mismatch the object is removed, the document becomes `FAILED`
and `409 INVALID_UPLOAD` is returned. The client can never mark a document
`READY` without a matching object existing.

Response `200`: `Document` with `status: "READY"`. Idempotent for a document
that is already `READY`.

Errors: `400 VALIDATION_ERROR`, `404 DOCUMENT_NOT_FOUND`,
`409 UPLOAD_NOT_FOUND` (nothing was uploaded yet), `409 INVALID_UPLOAD` (no
upload in progress / verification failed), `503 STORAGE_ERROR`.

#### `GET /documents/:id/download-url`

Rate limit: presign bucket. Only for `READY`, non-deleted documents.

Response `200`:

```json
{
  "downloadUrl": "http://localhost:9000/docuai-private/users/…?X-Amz-Algorithm=…",
  "method": "GET",
  "expiresAt": "2026-10-09T03:41:56.000Z",
  "expiresInSeconds": 300,
  "fileName": "invoice märz.pdf",
  "contentType": "application/pdf",
  "fileSize": 2030
}
```

The URL is valid for `S3_PRESIGNED_DOWNLOAD_EXPIRES_SECONDS` (default 5
minutes, hard maximum 15). Storage serves the object with the stored content
type and `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`,
so browsers download rather than render it. URLs are issued per request and
must not be stored by clients.

Errors: `404 DOCUMENT_NOT_FOUND`, `409 UPLOAD_NOT_READY`, `429 RATE_LIMITED`,
`503 STORAGE_ERROR`.

### OCR (Phase 3)

All OCR endpoints require authentication and are scoped to a document the
caller owns: unknown, soft-deleted and foreign documents answer
`404 DOCUMENT_NOT_FOUND` (foreign access is logged as
`DOCUMENT_ACCESS_DENIED`). A job id on its own never grants access — results
are always looked up as *(document, owner, job)*.

Supported inputs: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`
(the Phase 2 upload allowlist). The worker verifies the **bytes** of the
stored object; a file whose signature does not match its declared type fails
with `OCR_UNSUPPORTED_FILE_TYPE`.

#### `POST /documents/:id/ocr`

Queue text extraction / OCR for a `READY` document. Rate limited (see above).

Request (all fields optional):

```json
{ "language": "ind+eng", "forceReprocess": false }
```

- `language`: Tesseract codes joined by `+` (priority order), at most
  `OCR_MAX_LANGUAGES_PER_JOB` (3). Only languages listed by `/health/ocr` are
  accepted; omit for the configured default (`ind+eng`).
- `forceReprocess`: create a new job even if a finished job for the same
  language exists.
- Unknown properties (e.g. `userId`, `storageKey`, `status`) are rejected
  with `400 VALIDATION_ERROR`.

Duplicate-job policy, evaluated atomically per document:

| Situation | Response |
| --------- | -------- |
| No job, or latest job for this language is `FAILED`/`CANCELLED` | `202` — new job (`status: QUEUED`) |
| `forceReprocess: true` | `202` — new job; previous jobs and their pages are kept |
| An active (`QUEUED`/`PROCESSING`) job with the **same** language exists | `200` — that job, message `An OCR job for this document is already in progress` |
| An active job with a **different** language exists | `409 OCR_ALREADY_PROCESSING` |
| Latest job for this language is `COMPLETED`/`PARTIAL` and no force | `200` — that job, message `OCR results for this language already exist; pass forceReprocess to run again` |

Response `202` / `200`: an `OcrJob`. The job row is committed before the
response; the HTTP request never waits for processing. If the queue is
unreachable at that moment the job still exists as `QUEUED` and the worker's
reconciler schedules it (every `OCR_RECONCILE_INTERVAL_MS`).

Errors: `400 VALIDATION_ERROR`, `400 OCR_UNSUPPORTED_LANGUAGE`,
`404 DOCUMENT_NOT_FOUND`, `409 OCR_DOCUMENT_NOT_READY`,
`409 OCR_ALREADY_PROCESSING`, `413 OCR_FILE_TOO_LARGE`,
`413 OCR_PAGE_LIMIT_EXCEEDED` (when the page count is already known from an
earlier job), `415 OCR_UNSUPPORTED_FILE_TYPE`, `429 OCR_TOO_MANY_JOBS`
(more than `OCR_MAX_ACTIVE_JOBS_PER_USER` active jobs, or
`OCR_MAX_JOBS_PER_DOCUMENT` jobs for this document), `429 RATE_LIMITED`,
`503 OCR_UNAVAILABLE`.

#### `GET /documents/:id/ocr`

Latest job (by creation time) for the document, as an `OcrJob`. Poll this to
track progress.

Errors: `404 DOCUMENT_NOT_FOUND`, `404 OCR_NOT_FOUND` (no job yet).

#### `GET /documents/:id/ocr/results`

Page-level text of the latest job, or of a specific job of this document via
`jobId`.

Query parameters:

| Name | Default | Notes |
| ---- | ------- | ----- |
| `page` | 1 | Result page (≤ 100000) |
| `limit` | 10 | 1..50 — page texts can be large, so one response is bounded |
| `pageNumber` | — | Return only this document page (1-based) |
| `jobId` | latest | A job of this document, e.g. a previous attempt |

Response `200`:

```json
{
  "jobId": "uuid",
  "documentId": "uuid",
  "status": "PARTIAL",
  "language": "ind+eng",
  "extractionMethod": "OCR",
  "totalPages": 2,
  "errorCode": "OCR_PROCESSING_TIMEOUT",
  "pages": [
    { "pageNumber": 1, "status": "COMPLETED", "method": "OCR", "text": "…", "confidence": 93.71, "charCount": 29, "truncated": false, "errorCode": null },
    { "pageNumber": 2, "status": "FAILED", "method": null, "text": null, "confidence": null, "charCount": 0, "truncated": false, "errorCode": "OCR_PROCESSING_TIMEOUT" }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 2, "totalPages": 1 }
}
```

Pages are always ordered by `pageNumber` ascending. Behaviour by job status:

| Job status | Response |
| ---------- | -------- |
| `QUEUED`, `PROCESSING` | `409 OCR_NOT_READY` (no partial results are exposed while the worker owns the job) |
| `COMPLETED` | all pages `COMPLETED`/`EMPTY` |
| `PARTIAL` | every page present; failed pages have `text: null` and an `errorCode` |
| `FAILED` | pages persisted before the failure (usually none); job `errorCode` explains |
| `CANCELLED` | no pages |

Errors: `400 VALIDATION_ERROR`, `404 DOCUMENT_NOT_FOUND`, `404 OCR_NOT_FOUND`,
`409 OCR_NOT_READY`.

#### `POST /documents/:id/ocr/retry`

Creates a **new** job with the language of the latest job when that job is
`FAILED` or `PARTIAL` with a retryable error code. Previous jobs and pages are
kept; the new job becomes the latest. Rate limited and subject to the same
quotas as `POST /documents/:id/ocr`.

Response `202`: the new `OcrJob` (`attemptCount: 0`), message
`OCR retry queued`.

Errors: `404 DOCUMENT_NOT_FOUND`, `404 OCR_NOT_FOUND`,
`409 OCR_RETRY_NOT_ALLOWED` (latest job is active/`COMPLETED`/`CANCELLED`, or
failed with a permanent code such as `OCR_INVALID_FILE`),
`409 OCR_DOCUMENT_NOT_READY`, `429 OCR_TOO_MANY_JOBS`, `429 RATE_LIMITED`,
`503 OCR_UNAVAILABLE`.

#### Example OCR flow

```
POST /documents/:id/upload-url → PUT file → POST /documents/:id/upload-complete   (Phase 2)
       │
       ▼
POST /documents/:id/ocr { "language": "ind+eng" }        → 202 { status: QUEUED }
       │
       ▼  poll
GET  /documents/:id/ocr                                   → { status: PROCESSING, progress: 50 }
       │
       ▼  terminal
GET  /documents/:id/ocr/results?limit=10&page=1           → pages 1..10
GET  /documents/:id/ocr/results?pageNumber=7              → one page
```

## Example client flow

```
register/login ──► store accessToken (memory) + refreshToken (secure storage)
       │
       ▼
call API with Authorization: Bearer <accessToken>
       │ 401 AUTH_INVALID_TOKEN (expired)
       ▼
POST /auth/refresh { refreshToken } ──► replace BOTH tokens
       │ 401 AUTH_REFRESH_TOKEN_* 
       ▼
clear tokens, show login screen
```
