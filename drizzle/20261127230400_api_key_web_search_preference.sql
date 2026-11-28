-- target: MIKKA_DATABASE_URL

-- Existing accounts keep Mikka Web Search off until the owner enables it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "apiKeyWebSearch" boolean NOT NULL DEFAULT false;
