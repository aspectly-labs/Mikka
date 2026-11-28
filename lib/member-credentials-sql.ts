/**
 * The team admin switch 团队权限 › 订阅与 API Key (`workspace_personal_policies.subscriptions`)
 * as a SQL predicate: true unless the workspace turned members' own credentials off
 * (decision 2026-11-27-1740). No row, a personal workspace and a NULL workspace all
 * mean on. The workspace expression is referenced as text so a bound parameter
 * stays inferable. Dependency-free so catalogue readers can import it.
 */
export const memberCredentialsAllowedSql = (workspace: string) =>
  `NOT EXISTS (SELECT 1 FROM workspace_personal_policies mp WHERE mp."workspaceId"::text=(${workspace})::text AND NOT mp.subscriptions)`
