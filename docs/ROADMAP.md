# DocuAI Roadmap

## Phase 0 — Foundation (implemented)

Containerized NestJS, PostgreSQL/Prisma, Redis, health checking, request correlation, security middleware, tests, and documentation.

## Phase 1 — Authentication & User Management (implemented)

Users, registration, login, short-lived JWT access tokens, rotating opaque refresh tokens with reuse detection, logout, profile, default-deny guards, auth rate limiting, security events.

## Phase 2 — Document & File Management (implemented)

Folders, documents with a verified lifecycle (`DRAFT → UPLOADING → READY`, `FAILED`, soft `DELETED`), private S3-compatible object storage behind a `StorageProvider` abstraction, presigned upload/download URLs with server-side verification, strict ownership enforcement, file validation (MIME allowlist, size limit, file-name sanitisation), storage service in Docker Compose.

## Phase 3 — OCR & Document Text Extraction (implemented)

Native PDF text extraction (Poppler), real OCR with Tesseract 5 for scanned PDFs and JPEG/PNG/WebP images, per-page deterministic native-vs-OCR decision, page-level results with confidence, asynchronous BullMQ worker on the existing Redis with bounded concurrency, timeouts, bounded retries, crash recovery and a reconciler, `OcrJob`/`OcrPage` models, OCR endpoints (`request`, `status`, `results`, `retry`), ten installed languages (default `ind+eng`), resource limits, OCR health reporting, OCR runtime installed in the backend image.

## Future phases

- AI extraction, summaries, Q&A and full-text search over the persisted OCR text
- Thumbnails / PDF conversion (the `PROCESSING` document status is still reserved for such pipelines)
- Credits, subscriptions and payments
- Sharing and short-lived share links (no permanent public URLs)
- Retention: hard deletion of soft-deleted documents, their storage objects and OCR history
- OCR improvements: language detection, handwriting, layout/table reconstruction, a dedicated worker deployment
- Session/device management UI, email verification, password reset
- Android client
- Administration interface
- Production deployment, monitoring, backup, and recovery

Future work must preserve the response envelope, error codes and request correlation contracts introduced in Phase 0, the authentication contract of Phase 1, the ownership/storage-key guarantees of Phase 2 and the OCR job/page contract of Phase 3 (immutable terminal jobs, documented `OCR_*` codes, no extracted text or presigned URLs in logs).
