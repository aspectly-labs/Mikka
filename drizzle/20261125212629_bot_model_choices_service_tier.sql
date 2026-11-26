-- migrate: reviewed-data #3324 add a nullable service tier and constrain future writes without changing existing choices
-- target: MIKKA_DATABASE_URL

-- A chat's serving speed beside its model and reasoning effort (lib/model-capabilities.ts):
-- 'fast' or 'ultrafast' when the person turned it on for this Bot (or the Coordinator), null
-- for the workspace's default (model_order_settings.defaultServiceTier). A run uses it only
-- when the frozen model's provider advertises that speed.
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS "serviceTier" text;

DO $$ BEGIN
  ALTER TABLE bot_model_choices ADD CONSTRAINT bot_model_choices_service_tier_known CHECK ("serviceTier" IS NULL OR "serviceTier" IN ('standard','fast','ultrafast'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
