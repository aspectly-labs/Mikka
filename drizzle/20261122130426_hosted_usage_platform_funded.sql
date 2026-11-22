-- target: MIKKA_DATABASE_URL

-- #2934 (epic #2933): the part of a Mikka 额度 receipt's cost the platform funded, written at
-- settlement (HostedUsageStore.settle). A free-message turn records its whole cost here, a legacy
-- free allowance the part it drew; plan, purchased credit and debt are the workspace's own charge
-- and are never recorded here. Receipts settled before this column existed keep NULL: their
-- funding is unknown, never zero, and nothing is backfilled. Rollback: stop writing it, then drop it.
-- Added bare (no default, no check) so the hot ledger is not rewritten under its lock.
ALTER TABLE hosted_usage ADD COLUMN IF NOT EXISTS "platformMicroUsd" bigint;
