-- target: MIKKA_DATABASE_URL

-- How many times a claim handed this run back to the queue because something it read
-- changed before the claim response (app/v1/devices/[deviceId]/runs/[runId]/claim).
-- Bounds that loop: past the limit the run ends instead of being requeued again.
-- Additive with a constant default (no table rewrite); roll back application code only.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "claimRequeues" integer NOT NULL DEFAULT 0;
COMMIT;
