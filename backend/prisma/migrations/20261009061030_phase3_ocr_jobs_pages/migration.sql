-- Phase 3: OCR & Document Text Extraction (strictly additive).
-- The legacy Phase 0 "SystemConfig"/"system_config" tables are intentionally
-- left untouched; see docs/DATABASE.md.

-- CreateEnum
CREATE TYPE "OcrJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OcrExtractionMethod" AS ENUM ('NATIVE_TEXT', 'OCR', 'MIXED');

-- CreateEnum
CREATE TYPE "OcrPageStatus" AS ENUM ('COMPLETED', 'EMPTY', 'FAILED');

-- CreateTable
CREATE TABLE "ocr_jobs" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "OcrJobStatus" NOT NULL DEFAULT 'QUEUED',
    "language" VARCHAR(64) NOT NULL,
    "extraction_method" "OcrExtractionMethod",
    "total_pages" INTEGER,
    "processed_pages" INTEGER NOT NULL DEFAULT 0,
    "failed_pages" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ocr_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_pages" (
    "id" UUID NOT NULL,
    "ocr_job_id" UUID NOT NULL,
    "page_number" INTEGER NOT NULL,
    "status" "OcrPageStatus" NOT NULL,
    "method" "OcrExtractionMethod",
    "text" TEXT,
    "confidence" DECIMAL(5,2),
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ocr_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ocr_jobs_document_id_created_at_idx" ON "ocr_jobs"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "ocr_jobs_document_id_status_idx" ON "ocr_jobs"("document_id", "status");

-- CreateIndex
CREATE INDEX "ocr_jobs_user_id_created_at_idx" ON "ocr_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ocr_jobs_status_heartbeat_at_idx" ON "ocr_jobs"("status", "heartbeat_at");

-- CreateIndex
CREATE UNIQUE INDEX "ocr_pages_ocr_job_id_page_number_key" ON "ocr_pages"("ocr_job_id", "page_number");

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_pages" ADD CONSTRAINT "ocr_pages_ocr_job_id_fkey" FOREIGN KEY ("ocr_job_id") REFERENCES "ocr_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
