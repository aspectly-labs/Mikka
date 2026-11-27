-- migrate: reviewed-data #3388 ADR 2026-11-27-1615 closes waiting write approvals and rewrites stored external-write "ask" to "allow"; deny and allow rows are untouched
-- target: MIKKA_DATABASE_URL

-- No permission approvals (docs/design/decisions/2026-11-27-1615-no-permission-approvals.md):
-- nothing creates, lists or decides a write approval any more.
--
-- 1. A proposal still waiting for the person ('pending') can never be decided.
--    Close it as 'declined' with error 'approvalRetired': it never ran.
--    "decidedAt" stays NULL, so the settings activity log does not show it as
--    the person's own decision, and every reader that already understands
--    'declined' (approved-write views, browser and credential subagents) reads
--    it as "did not run".
-- 2. A stored "ask" in the external-write settings, on an agent head or a
--    workspace policy, becomes "allow"; "deny" and "allow" are untouched. Their
--    policy-version triggers move the version, so a receipt pinned to the old
--    settings is refused as writePolicyChanged rather than run.
--    A workspace whose account deletion is in progress is skipped: its row is
--    guarded against every write (account_deletion_workspace_guard) and is about
--    to go; a stored "ask" there already reads as allow at runtime.
--
-- Idempotent: a second run matches no rows. CLI run policy (cli_run_policy) and
-- daemon permission questions (agent_tool_approvals) are not write approvals and
-- are left to their own change.
SET LOCAL lock_timeout = '5s';
LOCK TABLE agent_kit_heads IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE workspace_computer_policies IN SHARE ROW EXCLUSIVE MODE;

UPDATE pending_actions SET status = 'declined', error = 'approvalRetired'
WHERE status = 'pending';

UPDATE agent_kit_heads
SET external_write_permissions = (
  SELECT jsonb_object_agg(e.key, CASE WHEN e.value = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e.value END)
  FROM jsonb_each(external_write_permissions) e
)
WHERE jsonb_typeof(external_write_permissions) = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_each_text(external_write_permissions) e WHERE e.value = 'ask');

-- The deletion guard table lives with the workspace target (DATABASE_URL). In a
-- split deployment, or before that target is migrated, it is absent here and
-- so is the guard trigger; PL/pgSQL plans only the branch it runs.
DO $$
BEGIN
  IF to_regclass('account_deletion_workspace_guards') IS NULL THEN
    UPDATE workspace_computer_policies
    SET external_write_permissions = (
      SELECT jsonb_object_agg(e.key, CASE WHEN e.value = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e.value END)
      FROM jsonb_each(external_write_permissions) e
    )
    WHERE jsonb_typeof(external_write_permissions) = 'object'
      AND EXISTS (SELECT 1 FROM jsonb_each_text(external_write_permissions) e WHERE e.value = 'ask');
  ELSE
    UPDATE workspace_computer_policies
    SET external_write_permissions = (
      SELECT jsonb_object_agg(e.key, CASE WHEN e.value = '"ask"'::jsonb THEN '"allow"'::jsonb ELSE e.value END)
      FROM jsonb_each(external_write_permissions) e
    )
    WHERE jsonb_typeof(external_write_permissions) = 'object'
      AND EXISTS (SELECT 1 FROM jsonb_each_text(external_write_permissions) e WHERE e.value = 'ask')
      AND NOT EXISTS (SELECT 1 FROM account_deletion_workspace_guards g WHERE g."workspaceId" = workspace_computer_policies."workspaceId");
  END IF;
END $$;
