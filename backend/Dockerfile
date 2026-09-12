FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma.config.ts tsconfig*.json nest-cli.json eslint.config.mjs .prettierrc ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://docuai:docuai_dev_password@postgres:5432/docuai npx prisma generate

COPY src ./src
COPY test ./test
RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
