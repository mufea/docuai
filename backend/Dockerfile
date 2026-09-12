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
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

EXPOSE 4310

# Apply pending migrations, then start the compiled server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
