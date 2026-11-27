import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { z } from 'zod'
import { openSecret, sealSecret, type Sealed } from '@/lib/secrets/crypto'
import { runtimeEnv } from '@/lib/env/server'
import { resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import {
  mcpServerKey, PluginError, type createWorkspaceMcpSchema, type McpAuthority, type McpServerGrant, type updateWorkspaceMcpSchema,
  type WorkspaceMcpServerDetail, type WorkspaceMcpServerView,
} from './contracts'
import { mcpToolName } from './connection-contracts'
import { McpOAuthFlow, mcpOAuthTransport, type McpOAuthRow, type McpOAuthSlot } from './mcp-oauth'
import { mcpFailure, runMcpCommand, type McpDependencies } from './mcp'
import { withPluginTransaction } from './transaction'

/**
 * Workspace (organization) MCP servers, as Capy's organization servers
 * (docs/design/decisions/2026-11-27-1705-workspace-mcp-servers-like-capy.md):
 *
 * - Any active member of the workspace adds, edits, connects, switches tools on
 *   or removes one. There is no admin allow/deny policy.
 * - "shared" (Capy's default): every thread uses the one workspace account.
 *   "member" (OAuth servers only): every thread uses its starter's own account;
 *   a starter who has not connected gets no such server in that thread.
 * - A thread uses the workspace's servers plus its starter's own servers; when
 *   the keys clash, the starter's own server wins (WorkspaceMcpStore.freeze).
 * - The credential is resolved by the frozen requester (the thread's starter),
 *   never by whoever sent the latest message, and a member's account is only
 *   ever read for that member's own runs.
 */
type Query = Pick<Pool | PoolClient, 'query'>
type ServerRow = {
  id: string; workspace_id: string; server_key: string; name: string; url: string; transport: 'http' | 'sse'; environment_id: string | null;
  connection_mode: 'shared' | 'member'; auth_kind: 'none' | 'header' | 'oauth'; enabled: boolean; revision: number;
  auth_header: string | null; ciphertext: string | null; iv: string | null; key_version: number | null;
  connection_status: 'connected' | 'needs_connect' | 'check_failed'; last_checked_at: Date | null; check_failure: string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}
type CreateInput = z.infer<typeof createWorkspaceMcpSchema>
type UpdateInput = z.infer<typeof updateWorkspaceMcpSchema>
type ToolRow = { name: string; enabled: boolean; description: string; available: boolean }

const MAX_SERVERS = 50
const columns = 'id,workspace_id,server_key,name,url,transport,environment_id,connection_mode,auth_kind,enabled,revision,auth_header,ciphertext,iv,key_version,connection_status,last_checked_at,check_failure,created_by,created_at,updated_at'
const headerAad = (row: Pick<ServerRow, 'workspace_id' | 'id' | 'url'>, header: string) => JSON.stringify(['workspace-mcp', row.workspace_id, row.id, row.url, header.toLowerCase()])
const oauthAad = (workspaceId: string, serverId: string, principal: string | null) => JSON.stringify(['workspace-mcp-oauth', workspaceId, serverId, principal ?? 'shared'])
const unavailable = () => new PluginError('mcpUnavailable', 403)

/** One canonical text of every frozen server's switched-off tools, for the claim fence. */
export function mcpToolFingerprint(entries: Iterable<{ serverId: string; tool: string }>): string {
  const lines = [...entries].map(entry => `${entry.serverId}\u0000${entry.tool}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

async function activeWorkspace(members: Query, userId: string, workspaceId: string) {
  const { rows: [row] } = await members.query<{ kind: 'personal' | 'team' }>(`SELECT w.kind FROM mikka_workspaces w
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$2 AND m.status='active' WHERE w.id=$1`, [workspaceId, userId])
  if (!row) throw new PluginError('workspaceAccessDenied', 403)
  return row
}

export class WorkspaceMcpServers {
  readonly oauth: McpOAuthFlow
  constructor(readonly pool: Pool, readonly env: Readonly<Record<string, string | undefined>> = runtimeEnv(), readonly membership?: Query,
    readonly dependencies: McpDependencies = {}, oauthTransport: () => { fetch: typeof fetch; close: () => Promise<unknown> } = mcpOAuthTransport) {
    this.oauth = new McpOAuthFlow(pool, env, oauthTransport)
  }

  private async members() { return this.membership ?? (await import('@/lib/workspace-db')).workspacePool }
  /** Every route and every run rechecks live membership: a removed member loses access at once. */
  async member(userId: string, workspaceId: string) { return activeWorkspace(await this.members(), userId, workspaceId) }

  private async row(query: Query, workspaceId: string, serverId: string, lock = '') {
    const { rows: [row] } = await query.query<ServerRow>(`SELECT ${columns} FROM workspace_mcp_servers WHERE id=$1 AND workspace_id=$2 ${lock}`, [serverId, workspaceId])
    if (!row) throw new PluginError('mcpNotFound', 404)
    return row
  }

  /** A write under the server's row lock, with membership checked before and after the lock wait. */
  private async write<T>(userId: string, workspaceId: string, serverId: string, work: (client: PoolClient, row: ServerRow) => Promise<T>) {
    await this.member(userId, workspaceId)
    return withPluginTransaction(this.pool, async client => {
      const row = await this.row(client, workspaceId, serverId, 'FOR UPDATE')
      const result = await work(client, row)
      await this.member(userId, workspaceId)
      return result
    })
  }

  // ---- accounts ----------------------------------------------------------

  callbackUrl(workspaceId: string, serverId: string) {
    const origin = resolveAppOrigin(this.env)
    if (!origin) throw new PluginError('mcpOAuthOriginUnavailable', 503)
    return new URL(withBasePath(`/api/workspaces/${workspaceId}/mcp-servers/${serverId}/oauth/callback`), origin).href
  }

  /**
   * The account a call uses: the workspace's one account (`principal` null, "shared") or
   * one member's own ("member"). The mode is rechecked under the lock, so an account is
   * never written or read for a mode the server has since left.
   */
  private slot(workspaceId: string, serverId: string, principal: string | null, actor: string | null): McpOAuthSlot {
    return {
      aad: oauthAad(workspaceId, serverId, principal),
      callbackUrl: () => this.callbackUrl(workspaceId, serverId),
      server: async client => {
        const row = await this.row(client, workspaceId, serverId, principal === null ? 'FOR UPDATE' : 'FOR SHARE')
        if (row.auth_kind === 'header') throw new PluginError('mcpOAuthNotSupported', 400)
        if ((row.connection_mode === 'member') !== (principal !== null)) throw new PluginError('mcpConnectionChanged', 409)
        return row
      },
      read: async client => (await client.query<McpOAuthRow>('SELECT * FROM workspace_mcp_oauth WHERE server_id=$1 AND user_id IS NOT DISTINCT FROM $2 FOR UPDATE', [serverId, principal])).rows[0],
      save: async (client, sealed, stateDigest, stateExpires) => {
        const values = [serverId, principal, sealed.ciphertext, sealed.iv, sealed.keyVersion, stateDigest, stateExpires]
        const updated = await client.query(`UPDATE workspace_mcp_oauth SET ciphertext=$3,iv=$4,key_version=$5,state_digest=$6,state_expires_at=$7,updated_at=now()
          WHERE server_id=$1 AND user_id IS NOT DISTINCT FROM $2`, values)
        if (!updated.rowCount) await client.query(`INSERT INTO workspace_mcp_oauth(id,server_id,user_id,ciphertext,iv,key_version,state_digest,state_expires_at)
          VALUES($8,$1,$2,$3,$4,$5,$6,$7)`, [...values, randomUUID()])
      },
      status: async (client, status, failure, changed) => {
        await client.query(`UPDATE workspace_mcp_oauth SET connected=$3,connected_by=CASE WHEN $3 THEN $4 ELSE connected_by END
          WHERE server_id=$1 AND user_id IS NOT DISTINCT FROM $2`, [serverId, principal, status === 'connected', actor])
        // A member's own account never changes the server's shared state.
        if (changed) await client.query(`UPDATE workspace_mcp_servers SET auth_kind='oauth',updated_at=now()${principal === null ? ',connection_status=$2,check_failure=$3' : ''} WHERE id=$1`,
          principal === null ? [serverId, status, failure] : [serverId])
        else if (principal === null) await client.query('UPDATE workspace_mcp_servers SET connection_status=$2,check_failure=$3 WHERE id=$1', [serverId, status, failure])
      },
    }
  }

  private principal(row: Pick<ServerRow, 'connection_mode'>, userId: string) { return row.connection_mode === 'member' ? userId : null }

  /** Capy's Connect: the shared account for a "shared" server, the caller's own for a "member" one. */
  async connect(userId: string, workspaceId: string, serverId: string) {
    await this.member(userId, workspaceId)
    const row = await this.row(this.pool, workspaceId, serverId)
    const result = await this.oauth.startSlot(this.slot(workspaceId, serverId, this.principal(row, userId), userId))
    await this.member(userId, workspaceId)
    return result.authorizationUrl ? { ...await this.detail(userId, workspaceId, serverId), authorizationUrl: result.authorizationUrl } : this.check(userId, workspaceId, serverId)
  }

  async callback(userId: string, workspaceId: string, serverId: string, input: { code: string; state: string; issuer?: string }) {
    await this.member(userId, workspaceId)
    const row = await this.row(this.pool, workspaceId, serverId)
    await this.oauth.callbackSlot(this.slot(workspaceId, serverId, this.principal(row, userId), userId), input)
    return this.check(userId, workspaceId, serverId)
  }

  /** Removes the caller's own account ("member"), or the workspace's ("shared": any member may, as Capy). */
  async disconnect(userId: string, workspaceId: string, serverId: string) {
    await this.write(userId, workspaceId, serverId, async (client, row) => {
      if (row.auth_kind === 'header') {
        await client.query(`UPDATE workspace_mcp_servers SET auth_kind='none',auth_header=NULL,ciphertext=NULL,iv=NULL,key_version=NULL,
          connection_status='needs_connect',check_failure=NULL,revision=revision+1,updated_at=now() WHERE id=$1`, [serverId])
        return
      }
      const principal = this.principal(row, userId)
      await client.query('DELETE FROM workspace_mcp_oauth WHERE server_id=$1 AND user_id IS NOT DISTINCT FROM $2', [serverId, principal])
      if (principal === null) await client.query(`UPDATE workspace_mcp_servers SET connection_status='needs_connect',check_failure=NULL,updated_at=now() WHERE id=$1`, [serverId])
    })
    return this.detail(userId, workspaceId, serverId)
  }

  // ---- reads ---------------------------------------------------------------

  private async view(rows: ServerRow[], userId: string): Promise<WorkspaceMcpServerView[]> {
    const ids = rows.map(row => row.id)
    const { rows: accounts } = await this.pool.query<{ server_id: string; user_id: string | null }>(`SELECT server_id,user_id FROM workspace_mcp_oauth
      WHERE server_id=ANY($1::uuid[]) AND connected AND (user_id IS NULL OR user_id=$2)`, [ids, userId])
    const { rows: counts } = await this.pool.query<{ server_id: string; count: number }>(`SELECT server_id,count(*)::int AS count FROM workspace_mcp_server_tools
      WHERE server_id=ANY($1::uuid[]) AND enabled AND available GROUP BY server_id`, [ids])
    const { rows: personal } = await this.pool.query<{ name: string }>('SELECT name FROM personal_mcp_servers WHERE user_id=$1 AND enabled', [userId])
    const ownKeys = new Set(personal.map(row => mcpServerKey(row.name)))
    return rows.map(row => {
      const account = accounts.some(entry => entry.server_id === row.id && entry.user_id === this.principal(row, userId))
      return {
        id: row.id, workspaceId: row.workspace_id, serverKey: row.server_key, name: row.name, url: row.url, transport: row.transport,
        environmentId: row.environment_id, connectionMode: row.connection_mode, authKind: row.auth_kind, enabled: row.enabled, revision: row.revision,
        createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        group: row.connection_mode === 'member' ? 'member' as const : 'organization' as const,
        connected: row.enabled && (row.auth_kind !== 'oauth' || account),
        toolCount: counts.find(entry => entry.server_id === row.id)?.count ?? 0,
        shadowedByPersonal: ownKeys.has(row.server_key),
      }
    })
  }

  async list(userId: string, workspaceId: string) {
    const workspace = await this.member(userId, workspaceId)
    const { rows } = await this.pool.query<ServerRow>(`SELECT ${columns} FROM workspace_mcp_servers WHERE workspace_id=$1 ORDER BY created_at,id`, [workspaceId])
    const servers = await this.view(rows, userId)
    return { workspaceId, workspaceKind: workspace.kind, canAdd: workspace.kind === 'team', servers, count: servers.length }
  }

  async detail(userId: string, workspaceId: string, serverId: string): Promise<WorkspaceMcpServerDetail> {
    await this.member(userId, workspaceId)
    const row = await this.row(this.pool, workspaceId, serverId)
    const [view] = await this.view([row], userId)
    const { rows: tools } = await this.pool.query<ToolRow>('SELECT tool_name AS name,enabled,description,available FROM workspace_mcp_server_tools WHERE server_id=$1 ORDER BY tool_name', [serverId])
    const { rows: accounts } = await this.pool.query<McpOAuthRow & { user_id: string | null; connected: boolean }>('SELECT * FROM workspace_mcp_oauth WHERE server_id=$1', [serverId])
    const principal = this.principal(row, userId)
    const own = accounts.find(account => account.user_id === principal)
    const connectedMembers = row.connection_mode === 'member' ? accounts.filter(account => account.connected && account.user_id).map(account => account.user_id!) : []
    const { rows: names } = connectedMembers.length ? await (await this.members()).query<{ userId: string; name: string }>(`SELECT "userId",name FROM mikka_workspace_members
      WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, connectedMembers]) : { rows: [] }
    const status = !row.enabled ? 'disabled' as const : row.auth_kind !== 'oauth' ? row.connection_status
      : !own?.connected ? 'needs_connect' as const : row.connection_status === 'check_failed' ? 'check_failed' as const : 'connected' as const
    return {
      ...view, status, lastCheckedAt: row.last_checked_at?.toISOString() ?? null, failureReason: row.check_failure,
      authorizationUrl: this.oauth.pendingAuthorizationUrl(own, { aad: oauthAad(workspaceId, serverId, principal) }), tools,
      // Only members still in the workspace are listed; a departed member's account is never used.
      connections: names.map(entry => ({ userId: entry.userId, name: entry.name })),
    }
  }

  // ---- writes ------------------------------------------------------------

  private async environment(workspaceId: string, environmentId: string | null | undefined) {
    if (!environmentId) return
    const { rowCount } = await (await this.members()).query('SELECT 1 FROM workspace_environments WHERE "workspaceId"=$1 AND id=$2 AND "archivedAt" IS NULL', [workspaceId, environmentId])
    if (!rowCount) throw new PluginError('environmentAccessDenied', 403)
  }

  private sealHeader(row: Pick<ServerRow, 'workspace_id' | 'id' | 'url'>, input: Pick<CreateInput, 'auth' | 'headers'>) {
    const header = input.headers ? '__headers__' : input.auth?.name.toLowerCase()
    if (!header) return null
    const value = input.headers ? JSON.stringify(input.headers) : input.auth!.value
    return { header, sealed: sealSecret(value, headerAad(row, header), this.env) }
  }

  async create(userId: string, workspaceId: string, input: CreateInput) {
    if ((await this.member(userId, workspaceId)).kind !== 'team') throw new PluginError('workspaceAccessDenied', 403)
    await this.environment(workspaceId, input.environmentId)
    const id = randomUUID()
    const credential = this.sealHeader({ workspace_id: workspaceId, id, url: input.url }, input)
    const created = await withPluginTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-mcp:${workspaceId}`])
      const { rows: existing } = await client.query<{ server_key: string }>('SELECT server_key FROM workspace_mcp_servers WHERE workspace_id=$1', [workspaceId])
      if (existing.length >= MAX_SERVERS) throw new PluginError('mcpLimitReached', 409)
      const taken = new Set(existing.map(row => row.server_key))
      // As Capy's form: a named key must be free; a derived one takes the next free suffix.
      const base = input.serverKey ?? mcpServerKey(input.name)
      if (input.serverKey && taken.has(base)) throw new PluginError('mcpServerKeyTaken', 409)
      const key = Array.from({ length: 100 }, (_, n) => n === 0 ? base : `${base.slice(0, 40 - `${n + 1}`.length - 1)}-${n + 1}`).find(candidate => !taken.has(candidate))
      if (!key) throw new PluginError('mcpServerKeyTaken', 409)
      await client.query(`INSERT INTO workspace_mcp_servers(id,workspace_id,server_key,name,url,transport,environment_id,auth_kind,enabled,auth_header,ciphertext,iv,key_version,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, workspaceId, key, input.name, input.url, input.transport, input.environmentId ?? null,
        credential ? 'header' : 'none', input.enabled, credential?.header ?? null, credential?.sealed.ciphertext ?? null, credential?.sealed.iv ?? null,
        credential?.sealed.keyVersion ?? null, userId])
      await activeWorkspace(await this.members(), userId, workspaceId)
      return id
    })
    return this.detail(userId, workspaceId, created)
  }

  /** Any member, as Capy. Every edit except a tool switch is a new revision: runs frozen on
   * the old one stop using it. A changed endpoint or credential drops every saved account. */
  async update(userId: string, workspaceId: string, serverId: string, input: UpdateInput) {
    await this.environment(workspaceId, input.environmentId)
    await this.write(userId, workspaceId, serverId, async (client, row) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) throw new PluginError('mcpConnectionChanged', 409)
      if (input.serverKey && input.serverKey !== row.server_key
        && (await client.query('SELECT 1 FROM workspace_mcp_servers WHERE workspace_id=$1 AND server_key=$2', [workspaceId, input.serverKey])).rowCount) throw new PluginError('mcpServerKeyTaken', 409)
      const url = input.url ?? row.url, transport = input.transport ?? row.transport
      const endpointChanged = url !== row.url || transport !== row.transport
      const credentialChanged = input.auth !== undefined || input.headers !== undefined
      let authKind = row.auth_kind, mode = input.connectionMode ?? row.connection_mode
      let header = row.auth_header
      let sealed: Sealed | null = row.ciphertext ? { ciphertext: row.ciphertext, iv: row.iv!, keyVersion: row.key_version! } : null
      if (credentialChanged || endpointChanged) {
        // A credential never follows an endpoint to another host.
        const next = credentialChanged ? this.sealHeader({ workspace_id: workspaceId, id: serverId, url }, { auth: input.auth ?? undefined, headers: input.headers ?? undefined }) : null
        header = next?.header ?? null; sealed = next?.sealed ?? null
        authKind = next ? 'header' : 'none'
        if (input.connectionMode === undefined) mode = 'shared'
        await client.query('DELETE FROM workspace_mcp_oauth WHERE server_id=$1', [serverId])
      }
      if (mode === 'member' && authKind !== 'oauth') throw new PluginError('mcpConnectionModeUnavailable', 400)
      // Capy: switching to "Each member" removes the workspace account; switching to "Shared" removes every member's.
      if (mode !== row.connection_mode) await client.query(`DELETE FROM workspace_mcp_oauth WHERE server_id=$1 AND ${mode === 'member' ? 'user_id IS NULL' : 'user_id IS NOT NULL'}`, [serverId])
      const reset = credentialChanged || endpointChanged || mode !== row.connection_mode
      await client.query(`UPDATE workspace_mcp_servers SET name=$2,url=$3,transport=$4,server_key=$5,environment_id=$6,enabled=$7,connection_mode=$8,auth_kind=$9,
        auth_header=$10,ciphertext=$11,iv=$12,key_version=$13,
        connection_status=CASE WHEN $14 THEN 'needs_connect' ELSE connection_status END,check_failure=CASE WHEN $14 THEN NULL ELSE check_failure END,
        revision=revision+1,updated_at=now() WHERE id=$1`, [serverId, input.name ?? row.name, url, transport, input.serverKey ?? row.server_key,
        input.environmentId === undefined ? row.environment_id : input.environmentId, input.enabled ?? row.enabled, mode, authKind,
        header, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null, reset])
    })
    return this.detail(userId, workspaceId, serverId)
  }

  async remove(userId: string, workspaceId: string, serverId: string) {
    await this.write(userId, workspaceId, serverId, client => client.query('DELETE FROM workspace_mcp_servers WHERE id=$1', [serverId]))
    return { deleted: true }
  }

  /**
   * One tool switch for every member's threads; any member may change it (Capy). Like a
   * personal switch it is not a connection change: the revision stays, running tasks keep
   * the server and every call rereads the switch. `expectedEnabled` is what the caller saw.
   */
  async setTool(userId: string, workspaceId: string, serverId: string, name: string, enabled: boolean, options: { expectedEnabled?: boolean } = {}) {
    const toolName = mcpToolName.parse(name)
    await this.member(userId, workspaceId)
    await withPluginTransaction(this.pool, async client => {
      await this.row(client, workspaceId, serverId, 'FOR SHARE')
      const { rows: [tool] } = await client.query<{ enabled: boolean }>('SELECT enabled FROM workspace_mcp_server_tools WHERE server_id=$1 AND tool_name=$2 FOR UPDATE', [serverId, toolName])
      if (!tool) throw new PluginError('mcpToolNotFound', 404)
      if (options.expectedEnabled !== undefined && tool.enabled !== options.expectedEnabled) throw new PluginError('mcpConnectionChanged', 409)
      if (tool.enabled !== enabled) await client.query('UPDATE workspace_mcp_server_tools SET enabled=$3,updated_at=now() WHERE server_id=$1 AND tool_name=$2', [serverId, toolName, enabled])
      await this.member(userId, workspaceId)
    })
    return this.detail(userId, workspaceId, serverId)
  }

  /** Lists every tool page with the caller's account ("member") or the workspace's, and
   * replaces the catalogue only after a complete listing. */
  async check(userId: string, workspaceId: string, serverId: string): Promise<WorkspaceMcpServerDetail> {
    await this.member(userId, workspaceId)
    const row = await this.row(this.pool, workspaceId, serverId)
    if (!row.enabled) return this.detail(userId, workspaceId, serverId)
    const tools: { name: string; description?: string }[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined, failure: string | null = null
    let status: 'connected' | 'needs_connect' | 'check_failed' = 'connected'
    for (let page = 0; page < 20; page++) {
      const result = await runMcpCommand(async () => {
        const target = await this.target(row, this.principal(row, userId))
        return { url: target.url, transport: target.transport, headers: target.headers, secrets: [...Object.values(target.headers), target.url] }
      }, cursor ? { cursor } : {}, this.dependencies, {
        code: error => {
          const reason = mcpFailure(error, 'connect')
          status = reason.status === 401 || error instanceof PluginError && error.code === 'mcpNeedsConnect' ? 'needs_connect' : 'check_failed'
          failure = error instanceof PluginError ? error.code : [reason.reason, reason.status].filter(Boolean).join(':')
          return 'mcpUnavailable'
        },
      }) as { tools?: unknown; nextCursor?: unknown; error?: string }
      const listed = Array.isArray(result.tools) ? result.tools.filter((tool): tool is { name: string; description?: string } =>
        Boolean(tool) && typeof (tool as { name?: unknown }).name === 'string' && mcpToolName.safeParse((tool as { name: string }).name).success) : null
      if (!listed || listed.length !== (result.tools as unknown[]).length) { if (status === 'connected') status = 'check_failed'; failure ??= 'invalidToolCatalogue'; break }
      tools.push(...listed)
      const next = typeof result.nextCursor === 'string' ? result.nextCursor : null
      if (!next) break
      if (cursors.has(next) || page === 19) { status = 'check_failed'; failure = 'toolCatalogueIncomplete'; break }
      cursors.add(next); cursor = next
    }
    await withPluginTransaction(this.pool, async client => {
      const current = await this.row(client, workspaceId, serverId, 'FOR UPDATE')
      if (current.revision !== row.revision) throw new PluginError('mcpConnectionChanged', 409)
      // A member's own sign-in state is theirs; it does not mark the shared server disconnected.
      if (!(status === 'needs_connect' && row.connection_mode === 'member'))
        await client.query('UPDATE workspace_mcp_servers SET connection_status=$2,last_checked_at=now(),check_failure=$3 WHERE id=$1', [serverId, status, failure])
      if (status !== 'connected') return
      await client.query('UPDATE workspace_mcp_server_tools SET available=false WHERE server_id=$1', [serverId])
      for (const tool of tools) await client.query(`INSERT INTO workspace_mcp_server_tools(server_id,tool_name,description) VALUES($1,$2,$3)
        ON CONFLICT(server_id,tool_name) DO UPDATE SET description=$3,available=true,updated_at=now()`, [serverId, tool.name, (tool.description ?? '').slice(0, 4000)])
    })
    return this.detail(userId, workspaceId, serverId)
  }

  // ---- runs ----------------------------------------------------------------

  /** The endpoint and headers for one call. `principal` is null for the workspace's account. */
  private async target(row: ServerRow, principal: string | null) {
    const value = row.auth_header ? openSecret({ ciphertext: row.ciphertext!, iv: row.iv!, keyVersion: row.key_version! }, headerAad(row, row.auth_header), this.env) : null
    const headers: Record<string, string> = row.auth_header === '__headers__' ? JSON.parse(value!) : row.auth_header ? { [row.auth_header]: value! } : {}
    if (row.auth_kind === 'oauth') {
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'authorization') delete headers[name]
      headers.Authorization = `Bearer ${await this.oauth.accessTokenSlot(this.slot(row.workspace_id, row.id, principal, null))}`
    }
    return { url: row.url, transport: row.transport, headers }
  }

  /** Called immediately before a remote list or call, after `validate`. Never returned by an API. */
  async connection(requester: string, workspaceId: string, grant: McpServerGrant) {
    if (grant.source !== 'workspace' || grant.ownerId !== requester) throw unavailable()
    const { rows: [row] } = await this.pool.query<ServerRow>(`SELECT ${columns} FROM workspace_mcp_servers WHERE id=$1 AND workspace_id=$2 AND enabled`, [grant.id, workspaceId])
    if (!row || row.revision !== grant.revision || row.connection_mode !== grant.mode) throw new PluginError('mcpUnavailable', 404)
    // "member": the requester's own account and nobody else's; "shared": the workspace's only.
    const target = await this.target(row, row.connection_mode === 'member' ? requester : null)
    const { rows: disabled } = await this.pool.query<{ name: string }>('SELECT tool_name AS name FROM workspace_mcp_server_tools WHERE server_id=$1 AND NOT enabled ORDER BY tool_name', [row.id])
    return { id: row.id, name: row.name, url: target.url, transport: target.transport, enabled: row.enabled, revision: row.revision,
      authKind: row.auth_kind, createdAt: row.created_at.toISOString(), headers: target.headers, disabledTools: disabled.map(tool => tool.name) }
  }
}

/**
 * The servers a run may use, frozen for its requester (the thread's starter). A server
 * without an account for that requester, outside the run's environment, or whose key
 * one of the requester's own servers already uses (`ownKeys`), is left out.
 */
export async function workspaceMcpGrants(query: Query, requester: string, workspaceId: string, environmentId: string | null | undefined, ownKeys: ReadonlySet<string>): Promise<McpServerGrant[]> {
  const { rows } = await query.query<Pick<ServerRow, 'id' | 'name' | 'server_key' | 'revision' | 'connection_mode' | 'auth_kind' | 'environment_id'> & { account: boolean }>(
    `SELECT s.id,s.name,s.server_key,s.revision,s.connection_mode,s.auth_kind,s.environment_id,
      EXISTS (SELECT 1 FROM workspace_mcp_oauth o WHERE o.server_id=s.id AND o.connected
        AND o.user_id IS NOT DISTINCT FROM (CASE WHEN s.connection_mode='member' THEN $2 ELSE NULL END)) AS account
    FROM workspace_mcp_servers s WHERE s.workspace_id=$1 AND s.enabled ORDER BY s.created_at,s.id`, [workspaceId, requester])
  return rows.filter(row => (row.environment_id === null || row.environment_id === (environmentId ?? null))
    && (row.auth_kind !== 'oauth' || row.account) && !ownKeys.has(row.server_key))
    .map(row => ({ id: row.id, name: row.name, revision: row.revision, ownerId: requester, grantId: null, source: 'workspace' as const, mode: row.connection_mode }))
}

/** Recheck frozen workspace grants: same workspace, enabled, same revision and mode, in scope. */
export async function validateWorkspaceMcpGrants(query: Query, authority: McpAuthority, grants: McpServerGrant[]) {
  if (!grants.length) return
  if (!authority.workspaceId) throw unavailable()
  const { rows } = await query.query<Pick<ServerRow, 'id' | 'workspace_id' | 'enabled' | 'revision' | 'connection_mode' | 'environment_id'>>(
    'SELECT id,workspace_id,enabled,revision,connection_mode,environment_id FROM workspace_mcp_servers WHERE id=ANY($1::uuid[])', [grants.map(grant => grant.id)])
  for (const grant of grants) {
    const row = rows.find(entry => entry.id === grant.id)
    if (!row || row.workspace_id !== authority.workspaceId || !row.enabled || row.revision !== grant.revision || row.connection_mode !== grant.mode
      || grant.ownerId !== authority.requester || row.environment_id !== null && row.environment_id !== (authority.environmentId ?? null)) throw unavailable()
  }
}

/** The switched-off tools of every frozen server, read on the claim's own transaction (and locked there). */
export async function lockedMcpToolFingerprint(query: Query, authority: McpAuthority) {
  const own = authority.servers.filter(server => server.source !== 'workspace').map(server => server.id)
  const shared = authority.servers.filter(server => server.source === 'workspace').map(server => server.id)
  // Every switch row is locked, not only the ones that are off: a switch turned off after
  // this read would otherwise commit before the claim does.
  type Switch = { server_id: string; tool_name: string; enabled: boolean }
  const { rows: personal } = await query.query<Switch>('SELECT server_id,tool_name,enabled FROM mcp_server_tools WHERE server_id=ANY($1::uuid[]) ORDER BY server_id,tool_name FOR SHARE', [own])
  const { rows: workspace } = shared.length ? await query.query<Switch>('SELECT server_id,tool_name,enabled FROM workspace_mcp_server_tools WHERE server_id=ANY($1::uuid[]) ORDER BY server_id,tool_name FOR SHARE', [shared]) : { rows: [] as Switch[] }
  return mcpToolFingerprint([...personal, ...workspace].filter(row => !row.enabled).map(row => ({ serverId: row.server_id, tool: row.tool_name })))
}
