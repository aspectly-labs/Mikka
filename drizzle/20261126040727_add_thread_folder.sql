-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Thread folders (#3333): match automation organization (`folder text` on the thread's root row).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS folder text;

COMMIT;
