-- Decision 2026-11-17 (continued): a subscription serves its owner only.
-- 20261117140000 emptied the sharing rows; nothing reads the table anymore —
-- runMayUseCredentialSql requires credential owner = run owner and
-- authorizeSubscriptionWorkspace refuses a borrower. Drop the dead surface so
-- no writer can resurrect sharing semantics through it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP TABLE IF EXISTS workspace_subscription_shares;
COMMIT;
