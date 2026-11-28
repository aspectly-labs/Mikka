-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- Task identifiers: the allocator exits a collision loop on rows where the
-- issued spelling lives on the task itself, not in the alias table. Built
-- CONCURRENTLY so writes to issues are not blocked. If a previous build
-- failed and left an INVALID index, scripts/migrate.mjs drops it and replays.
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_issued_identifier_lookup_idx
  ON issues ("workspaceId", "issuedIdentifier") WHERE "issuedIdentifier" IS NOT NULL;
