-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- A parent run reads its sub-agents (#2939) by "parentRunId". Built CONCURRENTLY so run writes are not blocked.
-- An INVALID leftover is dropped by scripts/migrate.mjs and this runs again.
-- Rollback: DROP INDEX CONCURRENTLY agent_runs_parent_run_idx.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_runs_parent_run_idx ON agent_runs ("parentRunId", "createdAt") WHERE "parentRunId" IS NOT NULL;
