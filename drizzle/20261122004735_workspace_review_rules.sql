-- target: MIKKA_DATABASE_URL

CREATE TABLE IF NOT EXISTS workspace_review_rules (
  "workspaceId" uuid NOT NULL,
  "repoKey" text NOT NULL DEFAULT '',
  "requirePullRequest" boolean NOT NULL DEFAULT true,
  "requireCi" boolean NOT NULL DEFAULT true,
  "checkHarness" text,
  "branchTemplate" text NOT NULL DEFAULT 'mikka/{team}-{number}',
  "prBodyTemplate" text,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspaceId", "repoKey"),
  CONSTRAINT workspace_review_rules_repo_key CHECK (
    "repoKey" = '' OR (
      length("repoKey") <= 250 AND
      "repoKey" ~ '^[a-z0-9._-]+/[a-z0-9._-]+/[a-z0-9._-]+$' AND
      "repoKey" !~ '(^|/)\.\.?(/|$)'
    )
  ),
  CONSTRAINT workspace_review_rules_harness CHECK (
    "checkHarness" IS NULL OR "checkHarness" IN ('claude_code', 'codex', 'cursor')
  ),
  CONSTRAINT workspace_review_rules_branch_len CHECK (
    length("branchTemplate") BETWEEN 1 AND 200
  ),
  CONSTRAINT workspace_review_rules_body_len CHECK (
    "prBodyTemplate" IS NULL OR length("prBodyTemplate") <= 20000
  )
);
