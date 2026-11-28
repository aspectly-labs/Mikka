-- migrate: reviewed-data #3316 existing attachments keep their task placement and only new inline uploads enter the retention index
-- target: MIKKA_DATABASE_URL

-- Files inside a task's description and comments (placement 'inline'), kept
-- in the task's own private file storage with the same access as the task.
-- They stay out of the task's file list and its 10-file cap. "mediaType" is a
-- raster image type recognised from the bytes (never the client's claim).
-- An inline file nothing references has "unreferencedAt" set; the existing
-- retention job (cleanupChatFiles -> cleanupTaskInlineFiles) deletes it a day
-- after upload if never referenced, else 30 days after its last reference
-- went, and the delete trigger retires its object. Additive and metadata-only
-- for existing rows (constant defaults); safe to run again.
SET LOCAL lock_timeout = '5s';
ALTER TABLE task_attachments
  ADD COLUMN IF NOT EXISTS placement text NOT NULL DEFAULT 'task',
  ADD COLUMN IF NOT EXISTS "mediaType" text,
  ADD COLUMN IF NOT EXISTS "referencedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "unreferencedAt" timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='task_attachments'::regclass AND conname='task_attachments_placement') THEN
    ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_placement CHECK (placement IN ('task','inline'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='task_attachments'::regclass AND conname='task_attachments_media_type') THEN
    ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_media_type
      CHECK ("mediaType" IS NULL OR "mediaType" IN ('image/png','image/jpeg','image/gif','image/webp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='task_attachments'::regclass AND conname='task_attachments_task_files_referenced') THEN
    ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_task_files_referenced
      CHECK (placement = 'inline' OR "unreferencedAt" IS NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS task_attachments_inline_unreferenced_idx ON task_attachments ("unreferencedAt")
  WHERE placement = 'inline' AND "unreferencedAt" IS NOT NULL;
