-- target: MIKKA_DATABASE_URL
-- Additive migration for #3328 new pricing credits:
--   1. Per-grant FIFO tracking for purchased top-up credits (12-month expiry).
--   2. Workspace overage toggle + mandatory monthly cap (off by default).
--   3. Idempotent grandfathering of any remaining card-verification allowances into non-expiring purchased grants.

ALTER TABLE hosted_usage
  ADD COLUMN IF NOT EXISTS "purchasedAllocations" jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof("purchasedAllocations") = 'object');

ALTER TABLE workspace_billing
  ADD COLUMN IF NOT EXISTS "overageEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "overageMonthlyCapPoints" integer
    CHECK ("overageMonthlyCapPoints" IS NULL OR "overageMonthlyCapPoints" BETWEEN 1 AND 100000000),
  ADD COLUMN IF NOT EXISTS "overageRevision" integer NOT NULL DEFAULT 0
    CHECK ("overageRevision" >= 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_billing_overage_cap_required'
      AND conrelid = 'workspace_billing'::regclass
  ) THEN
    ALTER TABLE workspace_billing
      ADD CONSTRAINT workspace_billing_overage_cap_required
      CHECK (NOT "overageEnabled" OR ("overageMonthlyCapPoints" IS NOT NULL AND "overageMonthlyCapPoints" > 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS workspace_credit_grants_bucket_expires_idx
  ON workspace_credit_grants ("workspaceId", bucket, "expiresAt");

INSERT INTO workspace_credit_grants (id, "workspaceId", bucket, points, reason, "externalId", "amountCents", currency, "expiresAt")
SELECT
  gen_random_uuid(),
  a."workspaceId",
  'purchased',
  ((a.remaining + 9999) / 10000)::integer,
  'allowance_grandfather',
  'grandfather:allowance:' || a."workspaceId"::text,
  0,
  'usd',
  NULL
FROM hosted_allowances a
WHERE a.remaining > 0
ON CONFLICT ("externalId") DO NOTHING;

UPDATE hosted_allowances
SET remaining = 0
WHERE remaining > 0
  AND EXISTS (
    SELECT 1 FROM workspace_credit_grants g
    WHERE g."externalId" = 'grandfather:allowance:' || hosted_allowances."workspaceId"::text
  );
