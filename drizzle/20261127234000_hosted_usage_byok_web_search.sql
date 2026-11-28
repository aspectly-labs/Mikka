-- target: MIKKA_DATABASE_URL

-- Historical hosted calls remain ordinary model usage.
SET LOCAL lock_timeout = '5s';
ALTER TABLE hosted_usage ADD COLUMN IF NOT EXISTS "byokWebSearch" boolean NOT NULL DEFAULT false;
