-- target: MIKKA_DATABASE_URL

-- #2934 item 5: which conversation turn a model call served, written when the call is made
-- (lib/usage-turn-ref.ts). One column for every chat: `eve:<session>:<turn>` (Bot chat),
-- `group:<message>` (group chat), `run:<run>:...` (agent threads). Existing receipts keep NULL;
-- nothing is backfilled by time. Rollback: stop writing it, then drop the column and its index.
ALTER TABLE hosted_usage ADD COLUMN IF NOT EXISTS "usageTurnRef" text
  CHECK ("usageTurnRef" IS NULL OR ("usageTurnRef" ~ '^(eve|group|run):[A-Za-z0-9:_.-]+$' AND length("usageTurnRef") <= 400));
