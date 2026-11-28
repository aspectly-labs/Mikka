-- migrate: reviewed-data #3368 Add nullable active chunk tracking columns and default lastSettledChunkIndex=-1 to e2b_compute_leases without rewriting existing debits.
-- target: MIKKA_DATABASE_URL
ALTER TABLE e2b_compute_leases
  ADD COLUMN IF NOT EXISTS "activeChunkStartedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "previousActiveChunkStartedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "providerTimeoutAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "lastSettledChunkIndex" integer NOT NULL DEFAULT -1;
