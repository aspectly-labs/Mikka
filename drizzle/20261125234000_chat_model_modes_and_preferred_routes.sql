-- migrate: reviewed-data #3324 add default-false Pro to existing picker rows
-- target: MIKKA_DATABASE_URL
-- Keep serviceTier as the shared representation of fast and ultrafast for older clients.
ALTER TABLE bot_model_choices ADD COLUMN IF NOT EXISTS pro boolean NOT NULL DEFAULT false;
