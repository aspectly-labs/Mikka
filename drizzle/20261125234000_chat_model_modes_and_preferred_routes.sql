-- migrate: reviewed-data #3324 add default-false Pro and empty route preferences to existing picker rows
-- target: MIKKA_DATABASE_URL
-- Keep serviceTier as the shared representation of fast and ultrafast for older clients.
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS pro boolean NOT NULL DEFAULT false;
ALTER TABLE model_favorites ADD COLUMN IF NOT EXISTS "preferredRoutes" jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Keep slots readable by previous servers during rollback.
ALTER TABLE model_favorites ADD COLUMN IF NOT EXISTS "slotDetails" jsonb NOT NULL DEFAULT '[]'::jsonb;
