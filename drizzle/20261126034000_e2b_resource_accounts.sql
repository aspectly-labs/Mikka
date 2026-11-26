-- migrate: reviewed-data #3320 Preserve the personal account of existing E2B allocation attempts in a new receipt table.
-- Provider IDs and create-operation receipts must stay bound to their original account.
CREATE TABLE IF NOT EXISTS e2b_resource_accounts (
  kind text NOT NULL CHECK (kind IN ('operation','sandbox','snapshot')),
  id text NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scope text NOT NULL,
  PRIMARY KEY (kind,id)
);

-- An interrupted pre-upgrade creation may already have allocated a personal sandbox.
-- A sleeping Bot placeholder with no attempt evidence reserves task identities only.
INSERT INTO e2b_resource_accounts(kind,id,"ownerId",scope)
SELECT 'operation',"operationId"::text,"ownerId",'personal' FROM cloud_machines
WHERE "operationId" IS NOT NULL AND (
  state <> 'sleeping' OR "sandboxId" IS NOT NULL OR "runtimeReady"
  OR "provisionLeaseId" IS NOT NULL OR "provisionLeaseUntil" IS NOT NULL OR "errorCode" IS NOT NULL
)
UNION ALL
SELECT 'operation',"operationId"::text,"ownerId",'personal' FROM thread_machines
WHERE "operationId" IS NOT NULL AND "snapshotId" NOT IN ('pending','cloudflare-task-v1')
UNION ALL
SELECT 'sandbox',"sandboxId","ownerId",'personal' FROM cloud_machines WHERE "sandboxId" IS NOT NULL
UNION ALL
SELECT 'sandbox',"sandboxId","ownerId",'personal' FROM thread_machines
WHERE "sandboxId" IS NOT NULL AND "snapshotId"<>'cloudflare-task-v1'
UNION ALL
SELECT 'sandbox',"sandboxId","ownerId",'personal' FROM sandbox_kill_retries
UNION ALL
SELECT 'snapshot',"filesystemSnapshotId","ownerId",'personal' FROM thread_machines
WHERE "filesystemSnapshotId" IS NOT NULL AND "snapshotId"<>'cloudflare-task-v1'
UNION ALL
SELECT 'snapshot',s."snapshotId",s."ownerId",'personal' FROM workspace_snapshots s JOIN "user" u ON u.id=s."ownerId"
ON CONFLICT DO NOTHING;
