-- target: DATABASE_URL
ALTER TABLE environment_snapshots ADD COLUMN IF NOT EXISTS "allocationAttempted" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS environment_snapshots_requester ON environment_snapshots ("requestedBy",id);

-- The workspace-side account guard is installed before external cleanup.
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON environment_snapshots;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON environment_snapshots
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('requestedBy');
