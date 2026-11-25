-- target: MIKKA_DATABASE_URL
-- Retain an explicit local deletion independently of concurrent publication acknowledgements.
SET LOCAL lock_timeout = '5s';
ALTER TABLE linear_comment_links ADD COLUMN IF NOT EXISTS "localDeletedAt" timestamptz;
