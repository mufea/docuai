#!/bin/sh
# Runs once when the PostgreSQL data volume is first initialised.
# Creates an isolated database for the automated test suite so tests can
# never truncate development data.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
  CREATE DATABASE "${POSTGRES_DB}_test" OWNER "$POSTGRES_USER";
EOSQL
