-- migrate: reviewed-data #3381 adds user."apiKeyWebSearch" boolean NOT NULL DEFAULT false with a constant PostgreSQL default.
-- target: MIKKA_DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "apiKeyWebSearch" boolean NOT NULL DEFAULT false;
COMMIT;
