-- migrate: reviewed-data #3381 adds a constant default so historical hosted calls remain ordinary model usage.
-- target: MIKKA_DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE hosted_usage ADD COLUMN IF NOT EXISTS "byokWebSearch" boolean NOT NULL DEFAULT false;
COMMIT;
