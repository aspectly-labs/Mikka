-- migrate: reviewed-data #3330 Bind Cloudflare environment preparation receipts to an admitted run.
-- target: DATABASE_URL
ALTER TABLE environment_snapshots ADD COLUMN IF NOT EXISTS "buildRunId" uuid;
