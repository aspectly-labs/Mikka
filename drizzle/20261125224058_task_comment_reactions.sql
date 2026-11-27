-- target: MIKKA_DATABASE_URL

-- Emoji reactions on a task's comments, as Linear and GitHub have them. A
-- comment is a message in the task document's discussions (issue_documents,
-- lib/task-discussion.ts), addressed by its thread and message ids. One row is
-- one person's one emoji: the key makes a second identical reaction a no-op.
-- app/actions/task-comments.ts checks the task ACL and that the message exists
-- on every write; rows go with the task, the person, or the deleted comment.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS task_comment_reactions (
  "taskId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "threadId" text NOT NULL CHECK (char_length("threadId") BETWEEN 1 AND 200),
  "messageId" text NOT NULL CHECK (char_length("messageId") BETWEEN 1 AND 300),
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId", "messageId", "userId", emoji)
);
CREATE INDEX IF NOT EXISTS task_comment_reactions_user_idx ON task_comment_reactions ("userId");
