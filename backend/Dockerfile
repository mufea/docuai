FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache libc6-compat openssl \
  && addgroup -S docuai \
  && adduser -S docuai -G docuai -h /home/docuai

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS development
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
RUN chmod +x docker-entrypoint.sh \
  && chown -R docuai:docuai /app
USER docuai
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]

FROM base AS production
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
  && npx prisma generate \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
  && chown -R docuai:docuai /app
USER docuai
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
