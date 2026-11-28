-- #2926: the composer's Keep awake switch persists on the thread's machine;
-- the idle-sleep decision (lib/cloud-computer/thread-lifecycle.ts) reads it.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "keepAwake" boolean NOT NULL DEFAULT false;
