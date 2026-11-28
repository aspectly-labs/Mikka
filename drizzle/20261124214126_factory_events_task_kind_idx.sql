-- migrate: reviewed-data #3267 additive concurrent index on factory_events, modifies zero rows
-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- Factory continuation and recovery queries filter factory_events on ("taskId", request->>'kind') ordered by "createdAt" DESC.
-- Built CONCURRENTLY so Factory writes are not blocked and an INVALID leftover is rebuilt by scripts/migrate.mjs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS factory_events_task_kind_idx
  ON factory_events ("taskId", (request->>'kind'), "createdAt" DESC);
