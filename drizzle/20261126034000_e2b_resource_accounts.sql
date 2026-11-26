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
INSERT INTO e2b_resource_accounts(kind,id,"ownerId",scope)
SELECT 'operation',"operationId"::text,"ownerId",'personal' FROM cloud_machines WHERE "operationId" IS NOT NULL
UNION ALL
SELECT 'operation',"operationId"::text,"ownerId",'personal' FROM thread_machines WHERE "operationId" IS NOT NULL
ON CONFLICT DO NOTHING;
