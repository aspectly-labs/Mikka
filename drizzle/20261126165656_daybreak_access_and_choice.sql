-- target: MIKKA_DATABASE_URL
-- #3315: add default-false Daybreak opt-in on bot_model_choices and per-key Daybreak access metadata on model_api_keys.
-- Additive only: older servers continue reading bot_model_choices and model_api_keys without changes.
-- Rollback: dropping the two columns removes only Daybreak opt-in state and cached key Daybreak grants.
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS daybreak boolean NOT NULL DEFAULT false;
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS daybreak jsonb;
