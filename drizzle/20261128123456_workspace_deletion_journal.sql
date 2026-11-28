-- migrate: reviewed-data #3444 Create an empty workspace deletion journal and indexes; preserve historical data and create no deletion requests.
-- target: MIKKA_DATABASE_URL

-- #3439 expansion only: no producer, recovery sweep or historical backfill.
-- A journal survives the workspace and its requester; neither has a cascading FK.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE workspace_deletion_jobs (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "requestedBy" text NOT NULL,
  "authorizationVersion" smallint NOT NULL,
  "authorizedAt" timestamptz NOT NULL,
  "requestedAt" timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL DEFAULT 'requested',
  "teamIds" uuid[],
  "projectIds" uuid[],
  "preparedAt" timestamptz,
  "mainDeletedAt" timestamptz,
  "workspaceDeletedAt" timestamptz,
  "completedAt" timestamptz,
  "cancelledAt" timestamptz,
  "deletedCounts" jsonb NOT NULL DEFAULT '{}',
  "nextAttemptAt" timestamptz DEFAULT now(),
  "retentionUntil" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_deletion_jobs_authority CHECK (
    "authorizationVersion" = 1 AND length(btrim("requestedBy")) BETWEEN 1 AND 256
    AND "authorizedAt" <= "requestedAt"
  ),
  -- NULL is unprepared. An empty frozen array means no matching IDs, never all rows.
  CONSTRAINT workspace_deletion_jobs_scope CHECK (
    ("preparedAt" IS NULL) = ("teamIds" IS NULL)
    AND ("preparedAt" IS NULL) = ("projectIds" IS NULL)
    AND CASE WHEN coalesce(array_ndims("teamIds"), 1) = 1
      THEN array_position("teamIds", NULL) IS NULL ELSE false END
    AND CASE WHEN coalesce(array_ndims("projectIds"), 1) = 1
      THEN array_position("projectIds", NULL) IS NULL ELSE false END
  ),
  CONSTRAINT workspace_deletion_jobs_counts CHECK (CASE WHEN jsonb_typeof("deletedCounts") = 'object' THEN
    "deletedCounts" - ARRAY['bots','threads','tasks','projects','teams','invitations','members'] = '{}'::jsonb
    AND (NOT "deletedCounts" ? 'bots' OR (jsonb_typeof("deletedCounts"->'bots') = 'number' AND "deletedCounts"->>'bots' ~ '^(0|[1-9][0-9]*)$'))
    AND (NOT "deletedCounts" ? 'threads' OR (jsonb_typeof("deletedCounts"->'threads') = 'number' AND "deletedCounts"->>'threads' ~ '^(0|[1-9][0-9]*)$'))
    AND (NOT "deletedCounts" ? 'tasks' OR (jsonb_typeof("deletedCounts"->'tasks') = 'number' AND "deletedCounts"->>'tasks' ~ '^(0|[1-9][0-9]*)$'))
    AND (NOT "deletedCounts" ? 'projects' OR (jsonb_typeof("deletedCounts"->'projects') = 'number' AND "deletedCounts"->>'projects' ~ '^(0|[1-9][0-9]*)$'))
    AND (NOT "deletedCounts" ? 'teams' OR (jsonb_typeof("deletedCounts"->'teams') = 'number' AND "deletedCounts"->>'teams' ~ '^(0|[1-9][0-9]*)$'))
    AND (NOT "deletedCounts" ? 'invitations' OR (jsonb_typeof("deletedCounts"->'invitations') = 'number' AND "deletedCounts"->>'invitations' ~ '^(0|[1-9][0-9]*)$'))
    AND (NOT "deletedCounts" ? 'members' OR (jsonb_typeof("deletedCounts"->'members') = 'number' AND "deletedCounts"->>'members' ~ '^(0|[1-9][0-9]*)$'))
    ELSE false END),
  CONSTRAINT workspace_deletion_jobs_progress CHECK (CASE stage
    WHEN 'requested' THEN "preparedAt" IS NULL AND "mainDeletedAt" IS NULL AND "workspaceDeletedAt" IS NULL
      AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "deletedCounts" = '{}'::jsonb
    WHEN 'prepared' THEN "preparedAt" IS NOT NULL AND "mainDeletedAt" IS NULL AND "workspaceDeletedAt" IS NULL
      AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "deletedCounts" = '{}'::jsonb
    WHEN 'main_deleted' THEN "preparedAt" IS NOT NULL AND "mainDeletedAt" IS NOT NULL AND "workspaceDeletedAt" IS NULL
      AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "deletedCounts" ?& ARRAY['bots','threads','tasks']
      AND "deletedCounts" - ARRAY['bots','threads','tasks'] = '{}'::jsonb
    WHEN 'workspace_deleted' THEN "preparedAt" IS NOT NULL AND "mainDeletedAt" IS NOT NULL AND "workspaceDeletedAt" IS NOT NULL
      AND "completedAt" IS NULL AND "cancelledAt" IS NULL
      AND "deletedCounts" ?& ARRAY['bots','threads','tasks','projects','teams','invitations','members']
    WHEN 'completed' THEN "preparedAt" IS NOT NULL AND "mainDeletedAt" IS NOT NULL AND "workspaceDeletedAt" IS NOT NULL
      AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL
      AND "deletedCounts" ?& ARRAY['bots','threads','tasks','projects','teams','invitations','members']
    WHEN 'cancelled' THEN "preparedAt" IS NULL AND "mainDeletedAt" IS NULL AND "workspaceDeletedAt" IS NULL
      AND "completedAt" IS NULL AND "cancelledAt" IS NOT NULL AND "deletedCounts" = '{}'::jsonb
    ELSE false END),
  CONSTRAINT workspace_deletion_jobs_times CHECK (
    isfinite("authorizedAt") AND isfinite("requestedAt") AND isfinite("updatedAt")
    AND ("preparedAt" IS NULL OR isfinite("preparedAt"))
    AND ("mainDeletedAt" IS NULL OR isfinite("mainDeletedAt"))
    AND ("workspaceDeletedAt" IS NULL OR isfinite("workspaceDeletedAt"))
    AND ("completedAt" IS NULL OR isfinite("completedAt"))
    AND ("cancelledAt" IS NULL OR isfinite("cancelledAt"))
    AND "updatedAt" >= greatest("requestedAt", "preparedAt", "mainDeletedAt", "workspaceDeletedAt", "completedAt", "cancelledAt")
    AND ("preparedAt" IS NULL OR "preparedAt" >= "requestedAt")
    AND ("mainDeletedAt" IS NULL OR "mainDeletedAt" >= "preparedAt")
    AND ("workspaceDeletedAt" IS NULL OR "workspaceDeletedAt" >= "mainDeletedAt")
    AND ("completedAt" IS NULL OR "completedAt" >= "workspaceDeletedAt")
    AND ("cancelledAt" IS NULL OR "cancelledAt" >= "requestedAt")
  ),
  -- Pending work has no expiry. Terminal identity/result receipts have a finite deadline.
  CONSTRAINT workspace_deletion_jobs_lifetime CHECK (
    (stage IN ('completed','cancelled')) = ("nextAttemptAt" IS NULL)
    AND ("nextAttemptAt" IS NULL OR isfinite("nextAttemptAt"))
    AND (stage IN ('completed','cancelled')) = ("retentionUntil" IS NOT NULL)
    AND ("retentionUntil" IS NULL OR (
      isfinite("retentionUntil") AND "retentionUntil" >= coalesce("completedAt", "cancelledAt")
      AND "retentionUntil" <= coalesce("completedAt", "cancelledAt") + interval '90 days'
    ))
  )
);
-- A completed request still owns this deleted workspace during receipt retention.
CREATE UNIQUE INDEX workspace_deletion_jobs_workspace_idx ON workspace_deletion_jobs("workspaceId") WHERE stage <> 'cancelled';
CREATE INDEX workspace_deletion_jobs_due_idx ON workspace_deletion_jobs("nextAttemptAt", id) WHERE stage NOT IN ('completed','cancelled');
CREATE INDEX workspace_deletion_jobs_retention_idx ON workspace_deletion_jobs("retentionUntil", id) WHERE stage IN ('completed','cancelled');
COMMIT;
