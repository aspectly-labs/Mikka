-- target: MIKKA_DATABASE_URL
-- Remembered approvals: the person's own 「始终同意」 on one approval card
-- (decision 2026-11-27-1500-remembered-approvals, lib/operations/approval-rules.ts).
-- One row is one allow rule for one owner and the Bot that asked, matching the
-- exact action and target the card showed (recipients, event, channel, page,
-- or an allow-listed app tool with its target arguments). "match" is what a
-- settings list shows; "matchKey" is sha256 of its canonical JSON, the only
-- thing a check compares.
-- A rule is bound to the Bot as it was when the person answered: its
-- workspace, its owner and "botFingerprint" (md5 of its instructions and the
-- person's active Agent definition version, lib/operations/approval-rule-store.ts).
-- A check matches only while all three are unchanged and the Bot is not
-- archived, so a Bot handed over, paused, re-instructed or redefined asks
-- again. Hand-over and a member leaving also delete the rows
-- (lib/workspace-admin/members.ts).
-- A rule only answers a default `ask`: a deny, or an ask an admin configured,
-- always wins, and no rule is written for an action the product never
-- remembers (browser, credential, cancel, any app tool off the allow-list).
-- Additive only: no existing row, reader or writer changes. Mirrors
-- lib/db/schema.ts (approvalRules).
-- Rollback: DROP TABLE IF EXISTS approval_rules;
--   DELETE FROM schema_migrations WHERE name = '20261127145325_approval_rules.sql';
CREATE TABLE IF NOT EXISTS approval_rules (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "botId" uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  match jsonb NOT NULL CHECK (jsonb_typeof(match) = 'object'),
  "matchKey" text NOT NULL CHECK ("matchKey" ~ '^[a-f0-9]{64}$'),
  -- The card the person answered, for the settings list; no FK, the card may be swept.
  "sourceActionId" uuid,
  "workspaceId" uuid NOT NULL,
  "botOwnerId" text,
  "botFingerprint" text NOT NULL CHECK ("botFingerprint" ~ '^[a-f0-9]{32}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastUsedAt" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_rules_owner_bot_match_key ON approval_rules ("ownerId", "botId", "matchKey");
CREATE INDEX IF NOT EXISTS approval_rules_bot_idx ON approval_rules ("botId");
CREATE INDEX IF NOT EXISTS approval_rules_owner_workspace_idx ON approval_rules ("ownerId", "workspaceId");
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON approval_rules;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON approval_rules FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
