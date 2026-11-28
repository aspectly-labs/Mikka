-- target: DATABASE_URL
ALTER TABLE environment_snapshots
  ADD COLUMN IF NOT EXISTS "enqueuedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "allocationStartedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "buildFinishedAt" timestamptz;
