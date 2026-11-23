-- target: MIKKA_DATABASE_URL
-- #2935 item 2: the right-hand rail's per-thread state ({tabs, active, open}),
-- so a thread's rail looks the same on every device and browser.
BEGIN;
CREATE TABLE IF NOT EXISTS thread_panels (
  "userId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "state" jsonb NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "runId")
);
COMMIT;
