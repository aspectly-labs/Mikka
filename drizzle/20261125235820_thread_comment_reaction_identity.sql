-- target: MIKKA_DATABASE_URL
-- migrate: reviewed-data #3316 widen the reaction identity to include its existing non-null thread id
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'task_comment_reactions'::regclass AND conname = 'task_comment_reactions_thread_pkey') THEN
    ALTER TABLE task_comment_reactions DROP CONSTRAINT task_comment_reactions_pkey,
      ADD CONSTRAINT task_comment_reactions_thread_pkey PRIMARY KEY ("taskId", "threadId", "messageId", "userId", emoji);
  END IF;
END $$;
