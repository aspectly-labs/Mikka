-- target: MIKKA_DATABASE_URL
-- #2939 sub-agent runs: the parent link is the same column C (thread lifecycle)
-- uses — both migrations tolerate either landing order. `name`/`profile`/`brief`
-- describe the child for the parent's card list.
BEGIN;
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS "parentRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "threadRelation" text CHECK ("threadRelation" IN ('fork','side','subagent')),
  ADD COLUMN IF NOT EXISTS "name" varchar(120),
  ADD COLUMN IF NOT EXISTS "profile" jsonb,
  ADD COLUMN IF NOT EXISTS "brief" text;
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs("parentRunId") WHERE "parentRunId" IS NOT NULL;
COMMIT;
