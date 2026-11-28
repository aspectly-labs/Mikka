-- target: MIKKA_DATABASE_URL

-- Workspace (organization) MCP servers, as Capy's organization servers
-- (decision 2026-11-27-1705-workspace-mcp-servers-like-capy). Any active member
-- adds, edits, connects or removes one. Additive: roll back application code
-- and keep these tables; never discard saved credentials. migrate.mjs runs it
-- once; the plain CREATE TABLE fails rather than index an existing table.
-- Membership lives in the workspace database and is checked there on every use,
-- so workspace_id carries no foreign key.
SET LOCAL lock_timeout = '5s';

CREATE TABLE workspace_mcp_servers (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  server_key text NOT NULL CHECK (server_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  url text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('http','sse')),
  -- One environment (Capy: one project) or the whole workspace (NULL).
  environment_id uuid,
  -- Capy's default is one organization account ("Shared"); "member" asks each
  -- thread's starter for their own account. Only an OAuth server can be "member".
  connection_mode text NOT NULL DEFAULT 'shared' CHECK (connection_mode IN ('shared','member')),
  auth_kind text NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none','header','oauth')),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  -- A header credential is the workspace's, sealed with the per-server envelope.
  auth_header text,
  ciphertext text,
  iv text,
  key_version integer,
  connection_status text NOT NULL DEFAULT 'needs_connect'
    CHECK (connection_status IN ('connected','needs_connect','check_failed')),
  last_checked_at timestamptz,
  check_failure text,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, server_key),
  CHECK (connection_mode = 'shared' OR auth_kind = 'oauth'),
  CHECK ((auth_kind = 'header') = (auth_header IS NOT NULL)),
  CHECK ((auth_header IS NULL AND ciphertext IS NULL AND iv IS NULL AND key_version IS NULL)
      OR (auth_header IS NOT NULL AND ciphertext IS NOT NULL AND iv IS NOT NULL AND key_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS workspace_mcp_servers_workspace_idx
  ON workspace_mcp_servers(workspace_id, created_at, id);

-- OAuth accounts: user_id NULL is the workspace's one shared account; a row per
-- member is that member's own account for a "member" server. Encrypted with the
-- existing workspace-secret crypto; no bearer or code is stored in clear.
CREATE TABLE workspace_mcp_oauth (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES workspace_mcp_servers(id) ON DELETE CASCADE,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  key_version integer NOT NULL,
  state_digest text,
  state_expires_at timestamptz,
  connected boolean NOT NULL DEFAULT false,
  connected_by text REFERENCES "user"(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_mcp_oauth_shared_idx
  ON workspace_mcp_oauth(server_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_mcp_oauth_member_idx
  ON workspace_mcp_oauth(server_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_mcp_oauth_user_idx
  ON workspace_mcp_oauth(user_id) WHERE user_id IS NOT NULL;

-- Per-server tool switches. One switch for every member's threads, as Capy's.
CREATE TABLE workspace_mcp_server_tools (
  server_id uuid NOT NULL REFERENCES workspace_mcp_servers(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  enabled boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  available boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(server_id, tool_name)
);
