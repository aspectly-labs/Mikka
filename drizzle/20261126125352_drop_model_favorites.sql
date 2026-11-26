-- target: MIKKA_DATABASE_URL
-- migrate: reviewed-data #3315 Drop retired model_favorites table after cancelling model favorites.
-- Model favorites were cancelled (Alex, 2026-11-26, #3315). All favorite RPCs
-- and readers are removed, and model_favorites never shipped to production.
-- Rollback: restore code and re-run 20261125223407_model_favorites.sql and
--   20261125234000_chat_model_modes_and_preferred_routes.sql if needed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP TABLE IF EXISTS model_favorites;
COMMIT;
