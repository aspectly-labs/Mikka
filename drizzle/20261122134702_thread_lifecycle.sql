-- target: MIKKA_DATABASE_URL
-- Thread lifecycle (#2936, Figma 1318:2 sections 13 and 15): soft delete, tags and fork.
-- "threadDeletedAt" is written on every run of a deleted thread, so each list reads its own row; it stays restorable
--   for 30 days (lib/thread-lifecycle.ts THREAD_RESTORE_DAYS) and is hidden from every list from the moment it is set.
-- "threadTags" lives on the thread's root run, as the pin and archive dates do.
-- "forkedFromRunId" and "forkPoint" are on a fork's root run: the run of the source thread it was forked from and the
--   message ({ runId, itemId, mode }) its context ends at. A sub-agent's "parentRunId" (#2939) is a different edge: a
--   fork is not dispatched by its source and must not be listed as its sub-agent.
-- Additive and nullable (tags default to none); existing rows are not changed.
-- Rollback: ALTER TABLE agent_runs DROP COLUMN "threadDeletedAt", DROP COLUMN "threadTags",
--   DROP COLUMN "forkedFromRunId", DROP COLUMN "forkPoint".
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "threadDeletedAt" timestamptz;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "threadTags" text[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "forkedFromRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "forkPoint" jsonb;
