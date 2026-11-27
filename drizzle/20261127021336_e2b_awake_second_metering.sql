-- target: MIKKA_DATABASE_URL
ALTER TABLE e2b_compute_leases
  ADD COLUMN IF NOT EXISTS "activeChunkStartedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "previousActiveChunkStartedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "lastSettledChunkIndex" integer NOT NULL DEFAULT -1;
