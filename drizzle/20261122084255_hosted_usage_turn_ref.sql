-- target: MIKKA_DATABASE_URL

-- #2934 item 5: which conversation turn a model call served, written when the call is made
-- (lib/usage-turn-ref.ts). One column for every chat: `eve:<session>:<turn>` (Bot chat),
-- `group:<message>` (group chat), `run:<run>:...` (agent threads). Existing receipts keep NULL;
-- nothing is backfilled by time. Rollback: stop writing it, then drop the column and its index.
-- The column is added bare and its format check NOT VALID, so the hot ledger is not scanned under an
-- ACCESS EXCLUSIVE lock. New and updated rows are checked at once, and every existing row is NULL.
ALTER TABLE hosted_usage ADD COLUMN IF NOT EXISTS "usageTurnRef" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hosted_usage_turn_ref_format' AND conrelid='hosted_usage'::regclass) THEN
    ALTER TABLE hosted_usage ADD CONSTRAINT hosted_usage_turn_ref_format
      CHECK ("usageTurnRef" IS NULL OR ("usageTurnRef" ~ '^(eve|group|run):[A-Za-z0-9:_.-]+$' AND length("usageTurnRef") <= 400)) NOT VALID;
  END IF;
END $$;
