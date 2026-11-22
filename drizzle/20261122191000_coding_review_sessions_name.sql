-- target: MIKKA_DATABASE_URL

-- #2940 item 1: a machine serves several terminals at once — sessions are
-- keyed (runId, kind, name) instead of (runId, kind). The empty name is the
-- terminal the existing /review/terminal routes keep minting, so current
-- callers and fences are unchanged.
ALTER TABLE coding_review_sessions ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
DO $$
DECLARE cname text;
BEGIN
  SELECT c.conname INTO cname FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='coding_review_sessions' AND c.contype='u'
      AND (SELECT array_agg(a.attname ORDER BY a.attname) FROM unnest(c.conkey) k
             JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k)::text[] = ARRAY['kind','runId'];
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE coding_review_sessions DROP CONSTRAINT %I', cname); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='coding_review_sessions_run_kind_name_key') THEN
    ALTER TABLE coding_review_sessions ADD CONSTRAINT coding_review_sessions_run_kind_name_key UNIQUE ("runId",kind,name);
  END IF;
END $$;
