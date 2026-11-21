-- APP: the workspace's saved task prefix mirrors into the counter row so the
-- allocator can honor it without reading across databases. NULL falls back to
-- the guarded W<uuid> prefix. Editing the prefix only renames future numbers;
-- issued identifiers and historical aliases never move.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE workspace_task_identifier_counters ADD COLUMN IF NOT EXISTS "savedPrefix" varchar(4);

CREATE OR REPLACE FUNCTION allocate_workspace_task_identifier(workspace_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE candidate_prefix text; candidate text;
BEGIN
  -- Thirteen characters exceed the Team key's maximum (12), and cannot
  -- overlap a personal prefix (4). The UNIQUE constraint guards UUID prefixes.
  candidate_prefix := 'W' || upper(substring(replace(workspace_id::text, '-', ''), 1, 12));
  BEGIN
    INSERT INTO workspace_task_identifier_counters ("workspaceId", prefix) VALUES (workspace_id, candidate_prefix)
      ON CONFLICT ("workspaceId") DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO workspace_task_identifier_counters ("workspaceId", prefix)
      VALUES (workspace_id, 'W' || upper(replace(workspace_id::text, '-', '')))
      ON CONFLICT ("workspaceId") DO NOTHING;
  END;
  LOOP
    UPDATE workspace_task_identifier_counters SET "lastNumber"="lastNumber"+1
      WHERE "workspaceId"=workspace_id AND "lastNumber"<9007199254740991
      RETURNING coalesce("savedPrefix", prefix) || '-' || "lastNumber"::text INTO candidate;
    IF candidate IS NULL THEN RAISE EXCEPTION 'Task identifier counter exhausted' USING ERRCODE='23514'; END IF;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM task_identifier_aliases WHERE "workspaceId"=workspace_id AND identifier=candidate)
      AND NOT EXISTS (SELECT 1 FROM issues WHERE "workspaceId"=workspace_id AND "issuedIdentifier"=candidate);
  END LOOP;
  RETURN candidate;
END $$;
COMMIT;
