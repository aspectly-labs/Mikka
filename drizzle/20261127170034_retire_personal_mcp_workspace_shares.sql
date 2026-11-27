-- migrate: reviewed-data #3392 withdraws every personal MCP workspace grant, closes the retired table to inserts, and stops active runs whose frozen MCP authority names another owner's server
-- target: MIKKA_DATABASE_URL
-- Personal MCP servers are not shareable (decision 2026-11-27-1700-personal-mcp-not-shareable).
-- 1. Every workspace grant of a personal MCP server is withdrawn, and a CHECK (false)
--    constraint stops any later insert, including one from an old build still serving during
--    the rollout. The code no longer reads this table; it is dropped in a later contract
--    migration once no deployed build references it.
-- 2. Active runs whose frozen MCP authority names a server owned by someone else are asked
--    to stop, as an organization MCP policy tightening already does (lib/governance/
--    resource-policy.ts). A native task machine received that credential at claim, so a
--    Mikka-side refusal of its next call alone would not reach it. Hosted calls and new claims
--    are refused by lib/plugins/workspace-mcp.ts validateMcpAuthority.
-- Idempotent: rerunning deletes nothing new, skips the existing constraint and finds those
-- runs already stopped.
-- Rollback: ALTER TABLE personal_mcp_workspace_shares DROP CONSTRAINT IF EXISTS
--   personal_mcp_workspace_shares_retired; withdrawn grants and stopped runs are not restored.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE personal_mcp_workspace_shares IN ACCESS EXCLUSIVE MODE;
DELETE FROM personal_mcp_workspace_shares;
DO $$ BEGIN
  ALTER TABLE personal_mcp_workspace_shares
    ADD CONSTRAINT personal_mcp_workspace_shares_retired CHECK (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE agent_runs r
SET "stopRequestedAt" = clock_timestamp(),
    "leaseExpiresAt" = least(r."leaseExpiresAt", clock_timestamp()),
    "updatedAt" = clock_timestamp()
WHERE r."stopRequestedAt" IS NULL
  AND r.status IN ('queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing')
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(r."agentDefinition" #> '{customMcp,servers}', '[]'::jsonb)) s
    WHERE s->>'ownerId' <> r."userId" OR s->>'grantId' IS NOT NULL
  );

COMMIT;
