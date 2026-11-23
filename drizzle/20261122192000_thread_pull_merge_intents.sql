-- target: MIKKA_DATABASE_URL

-- #2940 item 5: a person's "merge when ready" intent on a pull request their
-- thread published. The intent is durable so a later read (or the next poll)
-- performs the merge the moment GitHub admits it; the intent never widens
-- permission — the merge still runs as the person, with their token, through
-- mergePullRequest's own gates.
CREATE TABLE IF NOT EXISTS thread_pull_merge_intents (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "taskId" uuid,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  repo text NOT NULL,
  number integer NOT NULL,
  "headSha" text NOT NULL,
  "confirmFailedChecks" boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'armed' CHECK (state IN ('armed','cancelled','merged','failed')),
  "failCode" text,
  "mergeCommitSha" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("runId", repo, number)
);
CREATE INDEX IF NOT EXISTS thread_pull_merge_intents_owner_idx
  ON thread_pull_merge_intents ("ownerId", state);
