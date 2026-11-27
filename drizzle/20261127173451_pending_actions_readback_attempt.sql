-- migrate: reviewed-data #3388 adds nullable pending_actions."readbackAttemptAt" and removes the executable mutation from closed browser_operation rows (masked summary and digest kept); no other rows change
-- target: MIKKA_DATABASE_URL

-- No permission approvals (docs/design/decisions/2026-11-27-1615-no-permission-approvals.md).
--
-- 1. "readbackAttemptAt": when the safety-net sweep (lib/operations/write-receipt-sweep.ts)
--    last tried to read back a write receipt still running after its run ended.
--    The sweep tries untried receipts first, then the one tried longest ago, so
--    receipts no provider can settle do not starve newer ones. Nullable with no
--    default: a catalog-only change.
-- 2. drizzle/20261127162323_retire_write_approvals.sql closed every waiting
--    proposal, browser actions included, as 'declined'. A closed browser action
--    keeps only its masked summary and digest (lib/cloud-computer/action-reviews.ts
--    scrubBrowserMutation); this removes the executable mutation from every closed
--    browser_operation row still holding one, as sweepBrowserMutations does,
--    instead of waiting for the owner's next browser action.
--
-- Idempotent: a second run adds nothing and matches no rows.
SET LOCAL lock_timeout = '5s';

ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "readbackAttemptAt" timestamptz;

UPDATE pending_actions SET input = (input - 'mutation') || '{"mutationScrubbed":true}'::jsonb
WHERE action = 'browser_operation' AND input ? 'mutation' AND status IN ('done', 'declined', 'failed');
