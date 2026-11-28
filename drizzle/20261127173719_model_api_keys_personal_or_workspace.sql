-- migrate: reviewed-data #3396 empties model_api_key_shares (Alex 2026-11-27: personal keys are never shared), stops active runs and clears bot choices/order entries that name another person's key; additive workspaceId/addedBy columns
-- target: MIKKA_DATABASE_URL
-- Model API keys are a person's or a workspace's, never shared
-- (decision 2026-11-27-1740-model-keys-personal-or-workspace).
-- 1. A key belongs to exactly one person ("ownerId") or one workspace ("workspaceId").
--    A workspace key is sealed to the workspace (lib/model-api-keys.ts keyAad) and
--    records who added it ("addedBy") without belonging to them.
-- 2. Active runs handed another person's key are asked to stop: their key was a
--    teammate's share, which no longer authorizes anything. A device already holds
--    the gateway token; a Mikka-side refusal of the next claim alone would not reach it.
-- 3. Saved Bot chat choices and model-order entries that name another person's key
--    are cleared, so the chat or order falls back instead of failing at run time.
-- 4. Every share row is withdrawn and the table is closed to inserts with
--    CHECK (false), including from an old build still serving during the rollout.
--    Shares cannot become workspace keys: the ciphertext is bound to its owner, and
--    converting would hand a person's key to the workspace. Workspaces that relied on
--    one re-add the key under 工作区连接. The table is dropped by a later contract
--    migration once no deployed build references it.
-- Idempotent: rerunning adds nothing new, finds those runs already stopped and the
-- rows already cleared.
-- Rollback: ALTER TABLE model_api_key_shares DROP CONSTRAINT IF EXISTS model_api_key_shares_retired;
--   withdrawn shares, stopped runs and cleared choices are not restored. The new
--   columns stay until no workspace key remains.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE model_api_keys ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "workspaceId" uuid;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS "addedBy" text;
DO $$ BEGIN
  ALTER TABLE model_api_keys
    ADD CONSTRAINT model_api_keys_one_owner CHECK (("ownerId" IS NULL) <> ("workspaceId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS model_api_keys_workspace_idx ON model_api_keys ("workspaceId") WHERE "workspaceId" IS NOT NULL;

UPDATE agent_runs r
SET "stopRequestedAt" = clock_timestamp(),
    "leaseExpiresAt" = least(r."leaseExpiresAt", clock_timestamp()),
    "updatedAt" = clock_timestamp()
WHERE r."stopRequestedAt" IS NULL
  AND r.status IN ('queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing')
  AND (
    EXISTS (SELECT 1 FROM model_api_key_runs m JOIN model_api_keys k ON k.id = m."keyId"
      WHERE m."runId" = r.id AND k."ownerId" IS NOT NULL AND k."ownerId" <> r."userId")
    OR EXISTS (SELECT 1 FROM model_api_keys k
      WHERE k.id::text = r."agentDefinition" #>> '{apiKey,keyId}' AND k."ownerId" IS NOT NULL AND k."ownerId" <> r."userId")
  );

UPDATE bot_model_choices c SET "apiKeyId" = NULL, "apiKeyModel" = NULL
  FROM model_api_keys k
  WHERE k.id = c."apiKeyId" AND k."ownerId" IS NOT NULL AND k."ownerId" <> c."ownerId";

DELETE FROM model_order_entries e
  USING model_api_keys k
  WHERE e."sourceKind" = 'api_key' AND k.id = e."sourceId" AND k."ownerId" IS NOT NULL AND k."ownerId" <> e."ownerId";

LOCK TABLE model_api_key_shares IN ACCESS EXCLUSIVE MODE;
DELETE FROM model_api_key_shares;
DO $$ BEGIN
  ALTER TABLE model_api_key_shares
    ADD CONSTRAINT model_api_key_shares_retired CHECK (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
