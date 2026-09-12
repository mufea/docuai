#!/bin/sh
set -eu

echo "Waiting for PostgreSQL..."
i=0
until npx prisma migrate deploy; do
  i=$((i + 1))
  if [ "$i" -ge 20 ]; then
    echo "Prisma migrate failed after ${i} attempts"
    exit 1
  fi
  echo "Database not ready yet; retrying in 2s (${i}/20)"
  sleep 2
done

echo "Starting DocuAI API..."
if [ -f dist/main.js ]; then
  exec node dist/main.js
fi

exec node dist/src/main.js
