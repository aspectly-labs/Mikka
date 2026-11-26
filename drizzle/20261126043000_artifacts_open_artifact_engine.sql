-- migrate: reviewed-data #3346 additive engine/externalId/artifactType columns with default 'native' and partial unique index, modifies zero existing rows
-- target: MIKKA_DATABASE_URL

-- #3343: Unified artifact catalog metadata for Open Artifact rich-engine documents.
-- Existing native markdown/html rows remain valid with engine = 'native' and NULL externalId/artifactType.
-- Additive expand-only migration; safe for rolling readers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS "engine" text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS "externalId" text,
  ADD COLUMN IF NOT EXISTS "artifactType" text;

DO $$ BEGIN
  ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_engine_check
    CHECK ("engine" IN ('native', 'open_artifact'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_artifact_type_check
    CHECK (
      "artifactType" IS NULL
      OR "artifactType" IN (
        'markdown',
        'html',
        'docs',
        'slides',
        'design',
        'design-system',
        'whiteboard',
        'sheets',
        'data',
        'motion',
        'page'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_open_artifact_external_id_uidx
  ON artifacts ("externalId")
  WHERE "engine" = 'open_artifact' AND "externalId" IS NOT NULL;

COMMIT;
