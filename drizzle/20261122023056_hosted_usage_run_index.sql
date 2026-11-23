-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- Thread cost reads (#2934) select a chain's receipts by run. Built CONCURRENTLY so model
-- settlement is not blocked. An INVALID index left by a failed build is dropped by
-- scripts/migrate.mjs and this file runs again. Rollback: DROP INDEX CONCURRENTLY hosted_usage_run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hosted_usage_run ON hosted_usage ("usageRunId") WHERE "usageRunId" IS NOT NULL;
