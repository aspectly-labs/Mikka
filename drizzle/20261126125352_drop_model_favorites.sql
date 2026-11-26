-- target: MIKKA_DATABASE_URL
-- migrate: reviewed-data #3344 Drop retired model_favorites table after cancelling model favorites (#3315).
-- Model favorites were cancelled (Alex, 2026-11-26, #3315). All favorite RPCs
-- and readers are removed, and model_favorites never shipped to production.
-- Rollback: recreating the table via 20261125223407_model_favorites.sql and
--   20261125234000_chat_model_modes_and_preferred_routes.sql restores schema only;
--   recovering any pre-existing non-production rows requires a DB backup restore.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP TABLE IF EXISTS model_favorites;
COMMIT;
