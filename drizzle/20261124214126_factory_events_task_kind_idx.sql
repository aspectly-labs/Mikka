-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- Factory continuation and recovery queries join factory_events on ("taskId", request->>'kind') ordered by "createdAt" DESC.
-- Built CONCURRENTLY so Factory writes are not blocked, and an INVALID leftover is dropped by scripts/migrate.mjs and rebuilt.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS factory_events_task_kind_idx.
CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_events_task_kind_idx
  ON factory_events ("taskId", (request->>'kind'), "createdAt" DESC);
