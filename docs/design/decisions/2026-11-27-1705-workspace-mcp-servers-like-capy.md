# Workspace MCP servers, as Capy's organization servers

- Date: 2026-11-27 17:05 UTC
- **Status:** Accepted (Alex, 2026-11-27)
- Source: Alex, 2026-11-27: "follow Capy's organization MCP server logic and approach."
- Builds on: [native MCP authorization](2026-11-19-native-mcp-authorization.md), [MCP connection settings](2026-11-20-1852-mcp-connection-settings.md), [no permission approvals](2026-11-27-1615-no-permission-approvals.md).

## Like Capy (the spec)

Evidence: mikka-hosted-ui `docs/research/2026-11-27-public-evidence.md`.

1. A server is owned by the workspace (Capy: the organization) or by one person. Adding a server offers both; the workspace is the default.
2. Any member adds, edits, connects or removes a workspace server. No role is checked and there is no admin allow/deny policy.
3. A thread uses the workspace's servers plus the servers of the person who started it. When a personal server and a workspace server have the same key, the personal one is used.
4. A workspace server has a connection mode: shared (every thread uses one workspace account) or per member (every thread uses its starter's own account). Shared is the default and a new server is created shared. Only an OAuth server offers the choice.
5. Any member may switch the mode, after a confirmation. Switching to per member removes the workspace account; switching to shared removes every member's account.
6. In per-member mode each member connects their own account, and the server page lists who has connected. A thread whose starter has not connected cannot use the server's tools.
7. The list is grouped: shared by the workspace, connect your own account (per-member workspace servers), and yours (personal servers).
8. Each server has an Enabled switch (off means no member's thread can use it) and per-tool switches. An imported allow list and a read-only tool list exist but are not part of the main settings flow.
9. A stale edit or tool switch is refused instead of overwriting a newer change.
10. A personal server is usable in its owner's threads, including when other members message them, unless its owner opts it into private threads only.
11. A server can be limited to one project; it then works only in that project's threads.

## Decision

Mikka's **workspace MCP servers** are Capy's organization servers; a person's existing connections are Capy's personal servers. Mikka maps the organization to a team workspace and the project to an environment.

1. **Who:** any active member of a team workspace lists, adds, edits, checks, connects, switches tools on, disables or removes a workspace server. No role check and no admin policy ([no permission approvals](2026-11-27-1615-no-permission-approvals.md)). Membership is checked live on every request and every run, so a removed member loses every server at once; their own accounts on the workspace's servers are deleted when they leave.
2. **Modes:** `shared` (default) uses the workspace's one account — a header credential sealed on the server, or one OAuth account; `member` (OAuth servers only) uses the account of the run's requester. Switching removes accounts as in Capy. The mode is part of every frozen grant; a switch is a new revision, so runs frozen on the old mode stop using the server.
3. **Resolution:** a run's MCP authority is frozen for its requester — the thread's starter, who owns the Bot/Coordinator and the run — never for the latest message sender. It holds the requester's own servers, then the workspace's servers that are enabled, in the run's environment (or workspace-wide) and have an account for the requester; a workspace server whose key matches one of the requester's own servers is left out. Personal server keys are derived from their names (`mcpServerKey`).
4. **Accounts never cross members:** validation fixes `requester === caller`, so a `member` server only ever reads the requester's own account row, and a `shared` server only the workspace's. A starter who has not connected gets no such server in that run (spec 6, without the in-thread prompt; see below).
5. **Tool switches:** one switch per tool for every member's runs, changed by any member with `expectedEnabled` (409 on a stale view, spec 9). A switch keeps the revision: running tasks keep the server and each call rereads the switch. The device claim fence compares a fingerprint of the switched-off tools it exports with the locked rows and refuses a stale claim.
6. **Storage:** `workspace_mcp_servers`, `workspace_mcp_oauth` (`user_id` NULL is the shared account) and `workspace_mcp_server_tools`, in the application database, encrypted with the existing workspace-secret envelope.

## Not adopted yet

- An in-thread prompt asking an unconnected starter to connect a `member` server, the imported allow list and read-only tool list, machine-placed (command) workspace servers, plugin installations, and the personal-server private-threads-only switch: Mikka's coordinator does not yet tell a run whether others can message its thread, so the switch has nothing to enforce. Follow-ups.
- Personal servers shared into a workspace (`personal_mcp_workspace_shares`) are not part of Capy and are being removed separately; this record does not depend on them.

## Consequences

- API: `/api/workspaces/{workspaceId}/mcp-servers` (`GET` list, `POST` create), `/{serverId}` (`GET`, `PATCH`, `DELETE`), `/{serverId}/tools/{name}` (`PATCH`), `/{serverId}/check` (`POST`), `/{serverId}/connection` (`POST` connect, `DELETE` disconnect), `/{serverId}/oauth/callback` (`GET`). Every route needs a fresh human session.
- The hosted UI adds the owner choice to the add form, the three list groups, the server page's connection mode (with its confirmation) and member list, and per-member Connect.
