-- target: MIKKA_DATABASE_URL
-- Correct an existing main-store guard, including a store split after legacy shared deployment.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A committed audit receipt survives account/workspace deletion. Its append
-- is retained evidence, not a new business write. Keep the existing UPDATE
-- barrier and every other table's guard; never replace the shared function.
DO $$
DECLARE audit_table oid;
BEGIN
  SELECT c.oid INTO audit_table FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'workspace_audit_events';
  IF audit_table IS NULL THEN RETURN; END IF;
  -- Only an ordinary independent sink is known. Replacing a partition root's
  -- trigger also replaces child clones; unknown table shapes are not no-ops.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = audit_table AND relkind = 'r' AND NOT relispartition
  ) OR EXISTS (
    SELECT 1 FROM pg_inherits WHERE inhparent = audit_table OR inhrelid = audit_table
  ) THEN RAISE EXCEPTION 'audit_delivery_guard_unexpected'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = audit_table
      AND tgname = 'account_deletion_workspace_guard' AND NOT tgisinternal
  ) THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = audit_table
      AND tgname = 'account_deletion_workspace_guard' AND NOT tgisinternal
      AND tgfoid = to_regprocedure(format('%I.mikka_account_guard_workspace_write()', current_schema()))
      AND tgtype IN (19, 23) AND tgenabled = 'O' AND tgnargs = 0 AND tgqual IS NULL
      AND tgattr = ''::int2vector AND tgparentid = 0
  ) THEN RAISE EXCEPTION 'audit_delivery_guard_unexpected'; END IF;
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER account_deletion_workspace_guard BEFORE UPDATE ON %I.workspace_audit_events FOR EACH ROW EXECUTE FUNCTION %I.mikka_account_guard_workspace_write()',
    current_schema(), current_schema()
  );
END $$;

COMMIT;
