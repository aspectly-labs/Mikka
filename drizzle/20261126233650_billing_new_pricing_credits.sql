-- migrate: reviewed-data #3366 Grandfather positive hosted_allowances.remaining into non-expiring purchased workspace_credit_grants, subtracting exactly the converted amount once per workspace.
-- target: MIKKA_DATABASE_URL
-- Additive migration for #3328 new pricing credits:
--   1. Per-grant FIFO tracking for purchased top-up credits (12-month expiry).
--   2. Workspace overage toggle + mandatory monthly cap (off by default).
--   3. Idempotent grandfathering of any remaining card-verification allowances into non-expiring purchased grants.

-- A constant default adds the column without rewriting hosted_usage; the check is added NOT VALID (no scan
-- under the ACCESS EXCLUSIVE lock) and validated separately (SHARE UPDATE EXCLUSIVE, writes continue).
ALTER TABLE hosted_usage
  ADD COLUMN IF NOT EXISTS "purchasedAllocations" jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hosted_usage_purchased_allocations_object'
      AND conrelid = 'hosted_usage'::regclass
  ) THEN
    ALTER TABLE hosted_usage
      ADD CONSTRAINT hosted_usage_purchased_allocations_object
      CHECK (jsonb_typeof("purchasedAllocations") = 'object') NOT VALID;
  END IF;
END $$;

ALTER TABLE hosted_usage VALIDATE CONSTRAINT hosted_usage_purchased_allocations_object;

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

-- One statement converts exactly what it grants: a workspace that already has its grandfather grant is
-- skipped, so a later run never zeroes an allowance credited after the first one (a refund, for example).
WITH candidates AS (
  SELECT "workspaceId", remaining FROM hosted_allowances WHERE remaining > 0 FOR UPDATE
), granted AS (
  INSERT INTO workspace_credit_grants (id, "workspaceId", bucket, points, reason, "externalId", "amountCents", currency, "expiresAt")
  SELECT
    gen_random_uuid(),
    c."workspaceId",
    'purchased',
    ((c.remaining + 9999) / 10000)::integer,
    'allowance_grandfather',
    'grandfather:allowance:' || c."workspaceId"::text,
    0,
    'usd',
    NULL
  FROM candidates c
  ON CONFLICT ("externalId") DO NOTHING
  RETURNING "workspaceId"
)
UPDATE hosted_allowances a
SET remaining = a.remaining - c.remaining
FROM granted g JOIN candidates c ON c."workspaceId" = g."workspaceId"
WHERE a."workspaceId" = g."workspaceId";
