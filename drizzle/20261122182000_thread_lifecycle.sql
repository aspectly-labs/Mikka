-- target: MIKKA_DATABASE_URL
-- #2936 thread lifecycle: parent/child thread relations (shared with F), the
-- message a fork/side thread starts from, tags, a 30-day soft delete, read-only
-- share links, Slack-thread-to-thread binding, and automation provenance.
BEGIN;
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS "parentRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "threadRelation" text CHECK ("threadRelation" IN ('fork','side','subagent')),
  ADD COLUMN IF NOT EXISTS "sourceMessageId" uuid REFERENCES run_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "tags" jsonb,
  ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "deletedBy" text;
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs("parentRunId") WHERE "parentRunId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_runs_deleted_idx ON agent_runs("userId", "deletedAt") WHERE "deletedAt" IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_thread_shares (
  id uuid PRIMARY KEY,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "tokenHash" text NOT NULL,
  "createdBy" text NOT NULL,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_thread_shares_token_key UNIQUE ("tokenHash")
);
CREATE INDEX IF NOT EXISTS run_thread_shares_run_idx ON run_thread_shares("runId");
ALTER TABLE slack_thread_bots ADD COLUMN IF NOT EXISTS "boundRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS source_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
COMMIT;
