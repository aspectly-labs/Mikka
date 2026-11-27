-- migrate: reviewed-data #3388 adds nullable pending_actions."readbackAttemptAt" (catalog-only, no default), modifies zero rows
-- target: MIKKA_DATABASE_URL

-- No permission approvals (docs/design/decisions/2026-11-27-1615-no-permission-approvals.md).
--
-- "readbackAttemptAt": when the safety-net sweep (lib/operations/write-receipt-sweep.ts)
-- last tried to read back a write receipt still running after its run ended.
-- The sweep tries untried receipts first, then the one tried longest ago, and
-- skips one tried in the last five minutes, so receipts no provider can settle
-- do not starve newer ones and overlapping sweeps do not pick the same receipt.
-- Nullable with no default: a catalog-only change, so the ACCESS EXCLUSIVE lock
-- is held only briefly. The browser-mutation scrub is its own migration
-- (20261127175244_retired_browser_mutation_scrub.sql) so this lock is never held
-- across a table scan.
--
-- Idempotent: a second run adds nothing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "readbackAttemptAt" timestamptz;
