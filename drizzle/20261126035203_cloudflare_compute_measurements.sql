-- migrate: reviewed-data #3330 Add nullable Cloudflare compute price terms and measured usage to the existing credit ledger.
-- target: MIKKA_DATABASE_URL
ALTER TABLE hosted_usage ADD COLUMN IF NOT EXISTS "machineCompute" jsonb,
  ADD COLUMN IF NOT EXISTS "machineComputeReviewAt" timestamptz;
CREATE INDEX IF NOT EXISTS hosted_usage_machine_compute_due_idx ON hosted_usage("machineComputeReviewAt")
  WHERE "machineComputeReviewAt" IS NOT NULL;
