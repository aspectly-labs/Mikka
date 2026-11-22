-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- Turn usage reads (#2934) select receipts by turn. Built CONCURRENTLY so settlement is not blocked.
-- an INVALID leftover is dropped by scripts/migrate.mjs and this runs again.
-- Rollback: DROP INDEX CONCURRENTLY hosted_usage_turn_ref.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hosted_usage_turn_ref ON hosted_usage ("usageTurnRef") WHERE "usageTurnRef" IS NOT NULL;
