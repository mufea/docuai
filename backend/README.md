# DocuAI Backend

NestJS API with PostgreSQL/Prisma, Redis and S3-compatible object storage.
Phases 0 (foundation), 1 (authentication & users), 2 (documents, folders and
file storage) and 3 (OCR & text extraction) are implemented. See the root
`README.md` and `docs/` for the full picture.

## Local configuration

Copy `.env.example` to `.env` when running outside Docker and update the
dependency hostnames (`postgres`, `redis`, `storage`) to `localhost`. The
object store must be reachable at `S3_ENDPOINT`; the easiest option is the
compose service: `docker compose up -d storage` from the repository root.

### OCR runtime dependencies

Phase 3 shells out to **Tesseract 5** and **Poppler** (`pdfinfo`, `pdftotext`,
`pdftoppm`). The Docker image installs them; for local runs install them
yourself, e.g. on Debian/Ubuntu:

```bash
sudo apt-get install -y tesseract-ocr poppler-utils \
  tesseract-ocr-ind tesseract-ocr-eng tesseract-ocr-msa tesseract-ocr-ara \
  tesseract-ocr-chi-sim tesseract-ocr-jpn tesseract-ocr-kor \
  tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa
tesseract --list-langs      # must include at least the OCR_DEFAULT_LANGUAGE parts
```

`OCR_TESSERACT_PATH`, `OCR_POPPLER_PATH` and `OCR_TESSDATA_PREFIX` override
the binary/data locations when they are not on `PATH`. The API starts without
the tools (OCR endpoints then answer `503 OCR_UNAVAILABLE` and
`GET /health/ocr` lists what is missing), but the OCR test suites need them.

## Commands

```bash
npm install
npx prisma generate
npm run start:dev
npm run build
npm test            # unit + e2e; needs TEST_DATABASE_URL, Redis and the object store
npm run lint
```

Committed migrations are applied by the container entry command before the
API starts. Create future migrations with
`npx prisma migrate dev --name <name>` against a development database; do not
use `db push`.

The API uses the global prefix `/api/v1`. Swagger UI is served at
`/api/v1/docs` outside production.

## Module map

| Module | Responsibility |
| ------ | -------------- |
| `auth`, `users`, `security` | Registration, login, JWT, refresh-token rotation, profile, security events |
| `storage` | `StorageProvider` abstraction and the S3-compatible implementation (presigned URLs, HEAD, delete, bucket bootstrap) |
| `folders` | Per-user folder tree with cycle/depth protection and transactional delete |
| `documents` | Document metadata, soft delete, listing, and the presigned upload → verify → download flow |
| `ocr` | OCR jobs and page results: `tools/` (subprocess runner, byte-signature sniffing, Poppler, text rules), `providers/` (`OcrProvider` abstraction + Tesseract CLI implementation), extraction pipeline, BullMQ queue + worker + reconciler, languages, OCR health, `documents/:id/ocr*` endpoints |
| `health` | `GET /health` (database, redis, storage, informational `ocr`) and `GET /health/ocr` |

### OCR worker

The BullMQ worker is hosted inside the API process when
`OCR_WORKER_ENABLED=true` (the default) and uses the existing `REDIS_URL`.
To run a dedicated worker, start the same build twice: the API with
`OCR_WORKER_ENABLED=false` and a worker instance with `OCR_WORKER_ENABLED=true`
(it still serves HTTP, which is handy for its health endpoint). Concurrency
(`OCR_MAX_CONCURRENCY`), timeouts, retries and all limits are listed in
`.env.example` under "OCR".

## Tests

The e2e suite talks to real PostgreSQL, Redis and object storage. It forces a
dedicated bucket (`TEST_S3_BUCKET`, default `<S3_BUCKET>-test`) and refuses to
run against the development bucket or database; see `test/test-env.ts`.

OCR tests run the real Poppler + Tesseract toolchain against committed,
deterministic fixtures in `test/fixtures/ocr/` (native-text, scanned, mixed
and multi-page PDFs, PNG/JPEG/WebP, blank and corrupt files; expected
keywords in `expected.json`). The test environment uses its own queue name
(`docuai-ocr-test`) and Redis db 1 with short timeouts so lifecycle and
crash-recovery scenarios finish quickly.

Regenerate the fixtures (requires Poppler's `pdftoppm` and `cwebp` from the
`webp` package) with:

```bash
node test/fixtures/ocr/generate.mjs
```

The generator is deterministic; re-running it must not change any committed
file.
