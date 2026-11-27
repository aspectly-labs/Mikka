# Personal MCP servers are not shareable

- Date: 2026-11-27
- **Status:** Accepted
- Source: Alex, 2026-11-27: sharing a personal MCP server to a workspace lets every member's runs use the owner's own credential (OAuth token or headers); that must not exist. Clarified the same day: the owner's servers stay usable in threads the owner started, including when other members message those threads.
- Supersedes in part: the workspace-sharing clauses of [native MCP authorization](2026-11-19-native-mcp-authorization.md), [eve and native MCP](2026-11-11-0534-eve-and-native-mcp.md) and [MCP connection settings](2026-11-20-1852-mcp-connection-settings.md). [Workspace app permissions](2026-11-10-1730-workspace-app-permissions.md) was checked and has no MCP-sharing clause.

A personal MCP server belongs to one person and serves that person's runs only.
No other workspace member's run receives its URL, headers, OAuth token or STDIO
environment, and there is no way to share it into a workspace. Whose servers a
run gets is decided by the thread's starter (the run's requester), never by the
person who sent the latest message. A teammate who messages the owner's thread
uses the owner's servers there; in the teammate's own threads, only the
teammate's servers.

Reference: Capy 0.10.0 groups MCP servers as organization-shared, each member
connects, or "yours". A personal server is "visible only to you; members who
message your threads can use it". There is no control that moves a person's
server into the organization.

What changes:

- `personal_mcp_workspace_shares` is emptied and closed to inserts by migration
  `20261127170034_retire_personal_mcp_workspace_shares.sql`. The same migration
  asks active runs whose frozen MCP authority names another person's server to
  stop, since a native task machine already holds that credential. The table is
  dropped by a later contract migration.
- `validateMcpAuthority` refuses any reference whose owner is not the requester
  or that carries a grant ID. Hosted calls, run-token calls, native claims and
  execution-identity checks all use it, so an execution frozen while sharing
  existed fails closed on its next use.
- `PATCH /api/integrations/mcp/shares` answers 410 `mcpSharingRetired` after
  its usual human-session checks, for one release. The workspace listing keeps
  `canShare` and `shared` (always false) for the same release.
- Organization approvals no longer accept kind `mcp`; the `mcpSharing` policy
  now governs Skill sharing only.

Follow-up, not built: Capy's per-server "Private threads only" switch, which
hides a server from threads other members can message.

Cost if wrong: a team that relied on one member's MCP account must have each
member connect their own, until organization-owned MCP connections exist.
