-- target: MIKKA_DATABASE_URL

-- #2935: the right column's per-thread layout ({tabs, active, open}) is kept
-- per viewer, so a reload or another machine restores it.
CREATE TABLE IF NOT EXISTS thread_panel_states (
 "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 tabs jsonb NOT NULL DEFAULT '[]'::jsonb,
 active text NOT NULL DEFAULT '',
 open boolean NOT NULL DEFAULT false,
 "updatedAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("userId", "issueId")
);
