# Workspace MCP servers, as Capy's organization servers

- Date: 2026-11-27 17:00 UTC
- **Status:** Accepted (Alex, 2026-11-27)
- Source: Alex, 2026-11-27: "follow Capy's organization MCP server logic and approach."
- Builds on: [native MCP authorization](2026-11-19-native-mcp-authorization.md), [MCP connection settings](2026-11-20-1852-mcp-connection-settings.md), [no permission approvals](2026-11-27-1615-no-permission-approvals.md).

## Capy's behaviour (the spec)

Read from Capy 0.10.0's desktop renderer (`renderer/assets/…`, file@character offset) and its public docs (<https://docs.capy.ai/integrations/mcp>). No Capy source is copied here.

| # | Behaviour | Evidence |
| --- | --- | --- |
| 1 | A server's owner is the organization or one user (`McpOwner`: `{kind:'organization'}` \| `{kind:'user',userId}`); the add form offers **Organization** / **Only you** and defaults to Organization. | `mcp-DcSDqTOc.js`@606 (`McpOwner`), @2269 (`CreateMcpServerRequest.owner`); `form-Q4SuqVRk.js`@2180 (form default `owner:'organization'`), @17873–18447 (owner choice) |
| 2 | **Any member can add, edit, connect, or remove an organization server.** No role is checked and there is no admin allow/deny policy; the admin view (`/admin/orgs/$orgId/integrations/mcp`) lists the same servers in two groups. | docs ("Any member can add, edit, connect, or remove…"); `list-page-83XQ0c0X.js`@1755 (admin routes), @2898 and @6906 (admin groups) |
| 3 | A thread uses **the organization's servers plus the private servers of the person who started it**; on a key clash the **private** one wins. Tool names are `key__tool`. | docs; `form-Q4SuqVRk.js`@1693 (`ge`: a member's own row with the same `serverKey`/`projectId` stands in for the organization row) |
| 4 | An organization server's **connection mode**: `Shared`, "Every thread uses one organization account", or `Each member`, "Every thread uses its creator's own account". The stored field is `connection: 'organization' \| 'member'` and **defaults to `organization` (Shared)**; the create request has no connection field. Only an organization-owned OAuth server on the backend offers the choice. | `mcp-DcSDqTOc.js`@868 (`connection` default), @2269 (no connection on create); `server-page-M1RULs9s.js`@24643 (labels), @10873 (`Ue`: organization, not a plugin, `auth==='oauth'`, backend), @20185 (Connection mode select) |
| 5 | Switching mode is confirmed and **removes accounts**: to Each member, "The organization connection is removed"; to Shared, "Every member's connection … is removed. Someone then connects once." Any member can switch. | `server-page-M1RULs9s.js`@23040 (confirmation, `payload:{connection}`); docs |
| 6 | Each member connects their own account (OAuth start with `owner:'user'`, "Add for yourself"); the server page lists who has connected (`McpMemberConnection {serverId,userId,name,credential}`). "A thread whose creator hasn't connected can't call the server's tools, and Capy asks that person to connect." | `server-page-M1RULs9s.js`@15771 ("Add for yourself"), @24843 (member list); `mcp-DcSDqTOc.js`@1337 (`McpMemberConnection`); `form-Q4SuqVRk.js`@946 (`ue`); docs |
| 7 | List groups: **Shared by your organization**, **Connect your own account** (organization, Each member), **Added by you** (private). | `form-Q4SuqVRk.js`@1163 (`pe`), @1247 (titles); `list-page-83XQ0c0X.js`@7014 |
| 8 | Per server: `enabled` ("If anyone turns off its Enabled switch, no member's threads can use it"), `disabledTools` (switches under Tools), `allowedTools` (an allow list imported from a client config; `null` = all), `readOnlyTools` (accepted by the API, not shown in the UI). A tool is on when it is not disabled and, with an allow list, listed. | `mcp-DcSDqTOc.js`@1132; `server-page-M1RULs9s.js`@28328; `new-page-Bm4lBY89.js`@13665 (import); docs |
| 9 | Updates carry `expectedUpdatedAt` and `expectedDisabledTools`; a stale tool switch is refused and the tool list reloaded. | `mcp-DcSDqTOc.js`@3573; `server-page-M1RULs9s.js`@28046 |
| 10 | A private server: "Visible only to you; members who message your threads can use it", with an opt-in **Private threads only** ("Hidden from shared threads and threads other members can message"). | `server-page-M1RULs9s.js`@18948, @19592 |
| 11 | A server "can be limited to one project": "A server set to one Project works only in that project's threads." | docs; `form-Q4SuqVRk.js`@2180 (`projectId ?? 'org-wide'`) |

## Decision

Mikka's **workspace MCP servers** are Capy's organization servers; a person's existing connections are Capy's "Only you" servers. Mikka maps Capy's organization to a team workspace and Capy's project to an environment.

1. **Who:** any active member of a team workspace lists, adds, edits, checks, connects, switches tools on, disables or removes a workspace server. No role check and no admin policy (2, and [no permission approvals](2026-11-27-1615-no-permission-approvals.md)). Membership is checked live on every request and every run, so a removed member loses every server at once; their own accounts on the workspace's servers are deleted when they leave.
2. **Modes:** `shared` (default) uses the workspace's one account — a header credential sealed on the server, or one OAuth account; `member` (OAuth servers only) uses the account of the run's requester. Switching removes accounts as in Capy (5). The mode is part of every frozen grant; a switch is a new revision, so runs frozen on the old mode stop using the server.
3. **Resolution:** a run's MCP authority is frozen for its requester — the thread's starter, who owns the Bot/Coordinator and the run — never for the latest message sender. It holds the requester's own servers, then the workspace's servers that are enabled, in the run's environment (or workspace-wide) and have an account for the requester; a workspace server whose key matches one of the requester's own servers is left out (3). Personal server keys are derived from their names (`mcpServerKey`).
4. **Accounts never cross members:** validation fixes `requester === caller`, so a `member` server only ever reads the requester's own account row, and a `shared` server only the workspace's. A starter who has not connected gets no such server in that run (6, minus Capy's in-thread prompt; see below).
5. **Tool switches:** one switch per tool for every member's runs, changed by any member with `expectedEnabled` (409 on a stale view, 9). A switch keeps the revision: running tasks keep the server and each call rereads the switch. The device claim fence compares a fingerprint of the switched-off tools it exports with the locked rows and refuses a stale claim.
6. **Storage:** `workspace_mcp_servers`, `workspace_mcp_oauth` (`user_id` NULL is the shared account) and `workspace_mcp_server_tools`, in the application database, encrypted with the existing workspace-secret envelope.

## Not adopted yet

- Capy's in-thread "connect your account" prompt for an unconnected `member` server, `allowedTools` / `readOnlyTools`, machine-placed (command) organization servers, plugin installations, and the private-server **Private threads only** switch (10): Mikka's coordinator does not yet tell a run whether others can message its thread, so the switch has nothing to enforce. Follow-ups.
- Personal servers shared into a workspace (`personal_mcp_workspace_shares`) are not part of Capy and are being removed separately; this record does not depend on them.

## Consequences

- API: `/api/workspaces/{workspaceId}/mcp-servers` (`GET` list, `POST` create), `/{serverId}` (`GET`, `PATCH`, `DELETE`), `/{serverId}/tools/{name}` (`PATCH`), `/{serverId}/check` (`POST`), `/{serverId}/connection` (`POST` connect, `DELETE` disconnect), `/{serverId}/oauth/callback` (`GET`). Every route needs a fresh human session.
- The hosted UI adds the owner choice to the add form, Capy's three list groups, the server page's connection mode (with its confirmation) and member list, and per-member Connect.
