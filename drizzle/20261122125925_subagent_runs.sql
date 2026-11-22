-- target: MIKKA_DATABASE_URL
-- A sub-agent is a child run of the run that dispatched it (#2939, Figma 1318:2 section 22).
-- "parentRunId" points at that run; "brief" is the one line the dispatcher wrote about the work it handed over.
-- The sub-agent's name, mark and model are not stored again: they come from the run's frozen Agent Profile
-- (agentDefinition.agentProfile, factory_agent_profiles) and its model, as every other thread read does.
-- Additive and nullable; existing rows are not changed.
-- Rollback: DROP TRIGGER require_subagent_parent_run ON agent_runs; DROP FUNCTION require_subagent_parent_run();
--   ALTER TABLE agent_runs DROP COLUMN brief, DROP COLUMN "parentRunId".
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "parentRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS brief varchar(280);

-- A parent is set once, by the same owner, in the same Workspace, and never makes a loop.
-- Clearing it (the parent's deletion) is always allowed.
CREATE OR REPLACE FUNCTION require_subagent_parent_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentRunId" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."parentRunId" IS NOT NULL AND NEW."parentRunId" IS DISTINCT FROM OLD."parentRunId" THEN
    RAISE EXCEPTION 'subagentParentFixed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."parentRunId" IS NOT DISTINCT FROM OLD."parentRunId"
    AND NEW."userId" IS NOT DISTINCT FROM OLD."userId" AND NEW."workspaceId" IS NOT DISTINCT FROM OLD."workspaceId" THEN
    RETURN NEW;
  END IF;
  IF NEW."parentRunId" = NEW.id OR NEW."workspaceId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM agent_runs p WHERE p.id = NEW."parentRunId" AND p."userId" = NEW."userId" AND p."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'subagentParentMismatch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT r.id, r."parentRunId", 0 AS depth FROM agent_runs r WHERE r.id = NEW."parentRunId"
      UNION ALL SELECT r.id, r."parentRunId", up.depth + 1 FROM up JOIN agent_runs r ON r.id = up."parentRunId" WHERE up.depth < 64
    ) SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'subagentParentCycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS require_subagent_parent_run ON agent_runs;
CREATE TRIGGER require_subagent_parent_run BEFORE INSERT OR UPDATE OF "parentRunId", "userId", "workspaceId" ON agent_runs
FOR EACH ROW EXECUTE FUNCTION require_subagent_parent_run();
