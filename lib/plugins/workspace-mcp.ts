import type { Pool, PoolClient } from 'pg'
import { mcpAuthoritySchema, PluginError, type McpAuthority, type McpServerGrant, type McpWorkspacePage, type McpWorkspaceServerView } from './contracts'

type Query = Pick<Pool | PoolClient, 'query'>
type Workspace = { id: string; kind: 'personal' | 'team'; name: string }
type Row = { id: string; user_id: string; name: string; url: string; transport: 'http' | 'sse' | 'stdio'; enabled: boolean; revision: number; auth_header: string | null; created_at: Date; oauth_enabled: boolean; connection_status: string }
const columns = 's.id,s.user_id,s.name,s.url,s.transport,s.enabled,s.revision,s.auth_header,s.created_at,s.oauth_enabled,s.connection_status'
const unavailable = () => new PluginError('mcpUnavailable', 403)

/** The workspace and the member's own display name in it. */
async function workspaceMember(query: Query, userId: string, workspaceId: string): Promise<Workspace> {
  const { rows: [row] } = await query.query<Workspace>(`SELECT w.id,w.kind,m.name FROM mikka_workspaces w
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$2 AND m.status='active'
    WHERE w.id=$1`, [workspaceId, userId])
  if (!row) throw new PluginError('workspaceAccessDenied', 403)
  return row
}

/**
 * Query-only validation is usable inside admission/claim's existing transaction.
 *
 * A personal MCP server serves its owner only (decision 2026-11-27-1700): its credential never
 * reaches another person's run. A reference to someone else's server, or one that still carries a
 * workspace grant from before sharing was retired, is refused before any credential is read, so an
 * execution admitted with a formerly shared server fails closed on its next call or claim.
 */
export async function validateMcpAuthority(query: Query, userId: string, raw: McpAuthority, membership?: Query): Promise<McpAuthority> {
  const parsed = mcpAuthoritySchema.safeParse(raw)
  if (!parsed.success || parsed.data.requester !== userId) throw unavailable()
  const authority = parsed.data
  if (authority.servers.some(grant => grant.ownerId !== userId || grant.grantId !== null)) throw unavailable()
  if (authority.workspaceId) await workspaceMember(membership ?? (await import('@/lib/workspace-db')).workspacePool, userId, authority.workspaceId)
  const ids = authority.servers.map(server => server.id)
  if (new Set(ids).size !== ids.length) throw unavailable()
  const { rows } = await query.query<Row>(`SELECT ${columns} FROM personal_mcp_servers s WHERE s.id=ANY($1::uuid[]) AND s.user_id=$2`, [ids, userId])
  const { rows: bindings } = await query.query<{ server_id: string; workspace_id: string; environment_id: string }>('SELECT server_id,workspace_id,environment_id FROM mcp_server_environments WHERE server_id=ANY($1::uuid[])', [ids])
  for (const grant of authority.servers) {
    const scoped = bindings.filter(binding => binding.server_id === grant.id)
    if (scoped.length && !scoped.some(binding => binding.workspace_id === authority.workspaceId && binding.environment_id === authority.environmentId)) throw unavailable()
    const row = rows.find(server => server.id === grant.id)
    if (!row?.enabled || row.revision !== grant.revision) throw unavailable()
  }
  return authority
}

export async function lockNativeMcpAuthority(query: Query, userId: string, authority: McpAuthority) {
  if (!authority.servers.length) return
  await query.query('SELECT id FROM personal_mcp_servers WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [authority.servers.map(server => server.id)])
  await validateMcpAuthority(query, userId, authority)
}

/**
 * A member's own MCP servers, seen from one workspace. Membership scopes where a person's
 * servers may run; it never lends them to anyone else (decision 2026-11-27-1700).
 */
export class WorkspaceMcpStore {
  constructor(readonly pool: Pool, readonly membership?: Query) {}

  private async members() { return this.membership ?? (await import('@/lib/workspace-db')).workspacePool }

  async workspace(userId: string, workspaceId: string): Promise<Workspace> {
    return workspaceMember(await this.members(), userId, workspaceId)
  }

  private async available(userId: string, workspaceId: string | null, query: Query): Promise<Row[]> {
    if (workspaceId) await this.workspace(userId, workspaceId)
    const { rows } = await query.query<Row>(`SELECT ${columns} FROM personal_mcp_servers s WHERE s.user_id=$1 ORDER BY s.created_at,s.id`, [userId])
    return rows
  }

  /**
   * The member's own servers. `shared` and `canShare` are always false; they stay in the
   * response for one release so clients built before sharing was retired keep working.
   */
  async list(userId: string, workspaceId: string): Promise<McpWorkspacePage> {
    const workspace = await this.workspace(userId, workspaceId)
    const rows = await this.available(userId, workspaceId, this.pool)
    const servers: McpWorkspaceServerView[] = rows.map(row => ({
      id: row.id, name: row.name, url: row.url,
      transport: row.transport, enabled: row.enabled, revision: row.revision, authKind: row.oauth_enabled ? 'oauth' : row.transport === 'stdio' ? (row.auth_header === '__stdio_noenv__' ? 'none' : 'env') : row.auth_header ? 'header' : 'none',
      createdAt: row.created_at.toISOString(), ownerId: row.user_id, ownerName: workspace.name ?? null,
      mine: true, shared: false,
    }))
    return { workspaceId, workspaceKind: workspace.kind, canShare: false, servers, count: servers.length }
  }

  /** Freeze IDs, revisions and the owner (always the requester); no URL, headers, skills or private instructions. */
  async freeze(userId: string, workspaceId: string | null, query: Query = this.pool, environmentId?: string | null): Promise<McpAuthority> {
    // A connection whose OAuth consent is still pending has no usable credential: freezing it
    // would fail every claim, including a task that needs no MCP tool at all.
    const available = (await this.available(userId, workspaceId, query))
      .filter(row => row.enabled && !(row.oauth_enabled && row.connection_status === 'needs_connect')).slice(0, 64)
    const { rows: bindings } = await query.query<{ server_id: string; workspace_id: string; environment_id: string }>('SELECT server_id,workspace_id,environment_id FROM mcp_server_environments WHERE server_id=ANY($1::uuid[])', [available.map(row => row.id)])
    const rows = available.filter(row => { const scoped = bindings.filter(binding => binding.server_id === row.id); return !scoped.length || scoped.some(binding => binding.workspace_id === workspaceId && binding.environment_id === environmentId) })
    return { requester: userId, workspaceId, ...(environmentId ? { environmentId } : {}), servers: rows.map(row => ({
      id: row.id, name: row.name, revision: row.revision, ownerId: row.user_id, grantId: null,
    })) }
  }

  /** No grant discovery here: an old execution can use only the exact references frozen by its host. */
  async validate(userId: string, raw: McpAuthority, query: Query = this.pool): Promise<McpAuthority> {
    return validateMcpAuthority(query, userId, raw, this.membership)
  }
}

/**
 * The grants a frozen authority still has in this scope. A host freezes the bot's environment,
 * while the task may have selected another one: a connection left outside that scope is simply
 * not offered to the task, instead of failing a task that may not use it at all.
 */
export async function scopedMcpAuthority(query: Query, authority: McpAuthority): Promise<McpAuthority> {
  const ids = authority.servers.map(server => server.id)
  if (!ids.length) return authority
  const { rows: bindings } = await query.query<{ server_id: string; workspace_id: string; environment_id: string }>(
    'SELECT server_id,workspace_id,environment_id FROM mcp_server_environments WHERE server_id=ANY($1::uuid[])', [ids])
  return { ...authority, servers: authority.servers.filter(grant => {
    const scoped = bindings.filter(binding => binding.server_id === grant.id)
    return !scoped.length || scoped.some(binding => binding.workspace_id === authority.workspaceId && binding.environment_id === authority.environmentId)
  }) }
}

/** One connection's grant is rechecked without widening the frozen catalogue. */
export function singleMcpAuthority(authority: McpAuthority, id: string): McpAuthority & { servers: [McpServerGrant] } {
  const grant = authority.servers.find(server => server.id === id)
  if (!grant) throw new PluginError('mcpNotEnabledForExecution', 403)
  return { ...authority, servers: [grant] }
}
