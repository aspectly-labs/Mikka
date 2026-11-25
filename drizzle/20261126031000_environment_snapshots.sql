-- target: DATABASE_URL
-- Provider images belong to an installation. Keep the receipt even
-- after an environment is removed so its durable expiry job can delete it.
CREATE TABLE IF NOT EXISTS environment_snapshots (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "environmentId" uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  "providerScope" text NOT NULL,
  "requestedBy" text,
  "templateKind" text NOT NULL CHECK ("templateKind" IN ('codex','claude')),
  "templateId" text NOT NULL,
  "workerSha" text NOT NULL,
  state text NOT NULL CHECK (state IN ('building','ready','failed','outdated')),
  "logTail" text NOT NULL DEFAULT '',
  "providerId" text,
  "sandboxId" text,
  "repositoryIds" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS environment_snapshots_lookup ON environment_snapshots
  ("workspaceId","environmentId","providerScope","templateKind",revision,"createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS environment_snapshots_building ON environment_snapshots
  ("workspaceId","environmentId",revision,"providerScope","templateKind","templateId","workerSha")
  WHERE state='building';
