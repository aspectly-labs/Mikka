-- target: MIKKA_DATABASE_URL
-- Edit and Regenerate in a Bot chat (decision 2026-11-22-1700). A revision takes the chat's latest turn (the person's
--   last message and the reply after it) out of the chat and out of the Bot's model history, and sends the edited or the
--   same words again. The turn's rows stay in coordinator_messages, marked with the revision's id ("mikkaSuperseded"), so
--   the earlier version can be read back (‹ 1/2 ›) and nothing is lost.
-- "slot" groups the versions of one turn. "submissionId" is the person's message the revision sent, which the next
--   revision of the same turn finds its slot by. "clearedAt" is when eve cleared the session's model history;
--   "importedAt" is when the chat's remaining history was given back to it, with the next message.
-- Additive; existing rows are not changed.
-- Rollback: DROP TABLE bot_chat_revisions; then strip the "mikkaSuperseded" key from coordinator_messages.message.
CREATE TABLE IF NOT EXISTS bot_chat_revisions (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "botId" uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "requestId" uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('edit','regenerate')),
  slot uuid NOT NULL,
  "fromPosition" integer NOT NULL,
  "throughPosition" integer NOT NULL,
  "submissionId" uuid NOT NULL,
  "clearedAt" timestamptz,
  "importedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("userId","requestId")
);
CREATE INDEX IF NOT EXISTS bot_chat_revisions_chat ON bot_chat_revisions ("userId","botId","createdAt");
