-- target: MIKKA_DATABASE_URL

-- Settings > Models v6 (decision 2026-11-23):
-- 1. Allow multiple API keys per preset provider (e.g. personal + workspace shared keys).
-- 2. Backfill pre-LiteLLM rows so OpenAI-compatible keys serve both Agents via LiteLLM.
-- 3. Persist default reasoning effort alongside preferredHarness in model_order_settings.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP INDEX IF EXISTS model_api_keys_owner_provider_key;

UPDATE model_api_keys SET "responsesApi" = true WHERE "responsesApi" = false;

ALTER TABLE model_order_settings
  ADD COLUMN IF NOT EXISTS "defaultEffort" text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS "defaultServiceTier" text NOT NULL DEFAULT 'standard';

DO $$ BEGIN
  ALTER TABLE model_order_settings
    ADD CONSTRAINT model_order_settings_default_effort
    CHECK ("defaultEffort" IN ('low', 'medium', 'high', 'xhigh', 'max'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE model_order_settings
    ADD CONSTRAINT model_order_settings_default_service_tier
    CHECK ("defaultServiceTier" IN ('standard', 'fast', 'ultrafast'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
