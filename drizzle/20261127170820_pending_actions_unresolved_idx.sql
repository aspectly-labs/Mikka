-- migrate: reviewed-data #3388 ADR 2026-11-27-1615 additive concurrent partial index on pending_actions, modifies zero rows
-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- The safety-net sweep (lib/operations/write-receipt-due.ts) checks for write
-- receipts still pending or running every 15 minutes, and this keeps that check on
-- an index of the few unresolved rows. Built CONCURRENTLY so receipt writes are
-- not blocked and an INVALID leftover is rebuilt by scripts/migrate.mjs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pending_actions_unresolved_idx
  ON pending_actions ("createdAt") WHERE status IN ('pending', 'running');
