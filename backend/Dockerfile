# DocuAI backend image.
#
# This image intentionally keeps devDependencies and the TypeScript sources so
# that `docker compose exec backend npm test|run lint|run build` work inside
# the container during development and acceptance testing. A hardened
# production image should add a second stage that copies only `dist`,
# `prisma` and production dependencies.

FROM node:22-bookworm-slim AS base

ENV NODE_ENV=development \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# openssl is required by the Prisma query engine.
# Phase 3 OCR runtime: Tesseract (engine + the ten supported language packs)
# and Poppler utilities (pdfinfo, pdftotext, pdftoppm) for PDF text extraction
# and page rendering. Versions come from Debian bookworm (tesseract 5.3,
# poppler 22.12); language data is installed at build time only, never
# downloaded at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl ca-certificates \
        tesseract-ocr \
        tesseract-ocr-ind tesseract-ocr-eng tesseract-ocr-msa tesseract-ocr-ara \
        tesseract-ocr-chi-sim tesseract-ocr-jpn tesseract-ocr-kor \
        tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && tesseract --version \
    && tesseract --list-langs \
    && pdftoppm -v

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# Scratch space for OCR work directories (removed per job).
ENV OCR_TMP_DIR=/tmp/docuai-ocr

EXPOSE 4310

# Apply pending migrations, then start the compiled server. `exec` makes Node
# PID 1 so SIGTERM from `docker stop` reaches it and the OCR worker can drain
# the job in flight instead of being killed at the end of the grace period.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
