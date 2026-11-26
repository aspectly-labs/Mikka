-- target: MIKKA_DATABASE_URL
-- migrate: reviewed-data #3311 Add an archive pointer without modifying existing rows.
CREATE TABLE IF NOT EXISTS task_workspace_archives (
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "repositoryKey" text NOT NULL,
  "scopeHash" text NOT NULL CHECK ("scopeHash" ~ '^[0-9a-f]{64}$'),
  "archiveId" uuid NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  "sourceRunId" uuid NOT NULL,
  "sourceRunCreatedAt" timestamptz NOT NULL,
  "sourceEpoch" integer NOT NULL CHECK ("sourceEpoch" > 0),
  "sourceOperationId" uuid NOT NULL,
  PRIMARY KEY ("ownerId", "workspaceId", "issueId", "repositoryKey")
);
CREATE INDEX IF NOT EXISTS task_workspace_archives_issue_idx ON task_workspace_archives ("issueId");
CREATE UNIQUE INDEX IF NOT EXISTS task_workspace_archives_object_idx ON task_workspace_archives ("scopeHash", "archiveId");

-- Independently committed before PUT. Keep the receipt if the park transaction rolls back.
CREATE TABLE IF NOT EXISTS task_workspace_archive_objects (
  "scopeHash" text NOT NULL CHECK ("scopeHash" ~ '^[0-9a-f]{64}$'),
  id uuid NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  "expiresAt" timestamptz NOT NULL DEFAULT (now() + interval '1 day'),
  "deletedAt" timestamptz,
  PRIMARY KEY ("scopeHash", id)
);
CREATE INDEX IF NOT EXISTS task_workspace_archive_objects_due_idx ON task_workspace_archive_objects ("expiresAt") WHERE "deletedAt" IS NULL;
