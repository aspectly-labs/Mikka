import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PluginError } from './contracts'
import type { PersonalPluginStore } from './store'
import { WorkspaceMcpStore } from './workspace-mcp'
import { mcpEnvironmentSettings, mcpToolName, type McpConnectionDetails, type McpConnectionStatus, type McpToolView } from './connection-contracts'
import { McpOAuthStore } from './mcp-oauth'
import { mcpFailure, runMcpCommand, type McpDependencies } from './mcp'
import { saveToolSnapshot } from './tool-snapshot'
import { withPluginTransaction } from './transaction'

const pageSchema = z.object({ tools: z.array(z.object({ name: mcpToolName, description: z.string().max(100_000).optional() })), nextCursor: z.string().max(2048).nullable() })

export class McpConnectionStore {
  constructor(readonly personal: PersonalPluginStore, readonly dependencies: McpDependencies = {},
    readonly oauth = new McpOAuthStore(personal.pool, personal.env)) {}
  private async owned(userId: string, serverId: string) {
    const server = (await this.personal.listMcp(userId)).find(row => row.id === serverId)
    if (!server) throw new PluginError('mcpNotFound', 404)
    return server
  }
  private async members() { return this.personal.membership ?? (await import('@/lib/workspace-db')).workspacePool }

  async detail(userId: string, serverId: string, workspaceId?: string): Promise<McpConnectionDetails> {
    const sharing = new WorkspaceMcpStore(this.personal.pool, this.personal.membership)
    const candidates = workspaceId ? (await sharing.list(userId, workspaceId)).servers : await this.personal.listMcp(userId)
    const server = candidates.find(row => row.id === serverId)
    if (!server) throw new PluginError('mcpNotFound', 404)
    const manage = !('mine' in server) || server.mine || await sharing.workspaceAdmin(userId, workspaceId!)
    return this.readDetail(userId, server, workspaceId, manage)
  }

  /** `manage`: the owner, or an admin of the workspace the connection is shared to. They see
   * every tool with its switch; other members see only the tools that are on. */
  private async readDetail(userId: string, server: { id: string; enabled: boolean; mine?: boolean }, workspaceId: string | undefined, manage: boolean): Promise<McpConnectionDetails> {
    const { id: serverId, mine = true } = server
    const { rows: [state] } = await this.personal.pool.query<{ connection_status: McpConnectionStatus; last_checked_at: Date | null; check_failure: string | null }>(
      'SELECT connection_status,last_checked_at,check_failure FROM personal_mcp_servers WHERE id=$1', [serverId])
    if (!state) throw new PluginError('mcpNotFound', 404)
    const { rows: tools } = await this.personal.pool.query<McpToolView>(`SELECT tool_name AS name,enabled,description,available FROM mcp_server_tools
      WHERE server_id=$1 AND ($2::boolean OR (enabled AND available)) ORDER BY tool_name`, [serverId, manage])
    const { rows: environments } = await this.personal.pool.query<{ environment_id: string }>(`SELECT environment_id FROM mcp_server_environments
      WHERE server_id=$1 AND ($2::boolean OR workspace_id=$3) ORDER BY environment_id`, [serverId, mine, workspaceId ?? null])
    const { rows: [deviceCheck] } = mine ? await this.personal.pool.query<{ id: string; device_id: string; expires_at: Date }>(`SELECT id,device_id,expires_at FROM mcp_device_checks WHERE server_id=$1 AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [serverId]) : { rows: [] }
    const expired = deviceCheck && deviceCheck.expires_at.getTime() <= Date.now()
    return { id: serverId, status: server.enabled ? expired ? 'check_failed' : state.connection_status : 'disabled', lastCheckedAt: state.last_checked_at?.toISOString() ?? null,
      failureReason: expired ? 'deviceCheckExpired' : state.check_failure, authorizationUrl: mine ? await this.oauth.authorizationUrl(userId, serverId) : null,
      tools, environmentIds: environments.map(row => row.environment_id), canManageTools: manage, deviceCheck: deviceCheck ? { id: deviceCheck.id, deviceId: deviceCheck.device_id,
        expiresAt: deviceCheck.expires_at.toISOString(), status: deviceCheck.expires_at.getTime() > Date.now() ? 'pending' : 'expired' } : null }
  }

  async search(userId: string, options: { workspaceId?: string; query?: string; environmentId?: string } = {}) {
    const sharing = new WorkspaceMcpStore(this.personal.pool, this.personal.membership)
    const page = options.workspaceId ? await sharing.list(userId, options.workspaceId) : null
    const admin = page ? await sharing.workspaceAdmin(userId, page.workspaceId) : false
    const servers = page?.servers ?? await this.personal.listMcp(userId)
    const query = (options.query ?? '').trim().toLowerCase()
    if (query.length > 200) throw new PluginError('invalidPluginInput', 400)
    // One listing for every candidate, instead of a full detail (and its workspace listing)
    // per connection, so a search matching one connection reads one page of rows.
    const ids = servers.map(server => server.id)
    const { rows: bindings } = await this.personal.pool.query<{ server_id: string; workspace_id: string; environment_id: string }>(
      'SELECT server_id,workspace_id,environment_id FROM mcp_server_environments WHERE server_id=ANY($1::uuid[])', [ids])
    const managed = (server: (typeof servers)[number]) => !('mine' in server) || server.mine || admin
    const ownedIds = servers.filter(managed).map(server => server.id)
    const { rows: toolRows } = await this.personal.pool.query<{ server_id: string; name: string }>(
      `SELECT server_id,tool_name AS name FROM mcp_server_tools
      WHERE server_id=ANY($1::uuid[]) AND (server_id=ANY($2::uuid[]) OR (enabled AND available))`, [ids, ownedIds])
    const candidates = servers.filter(server => {
      const scoped = bindings.filter(binding => binding.server_id === server.id)
      // A connection bound only to other workspaces cannot run here, even though a teammate's
      // detail hides those bindings and so shows an empty, apparently unrestricted list.
      if (scoped.length && options.workspaceId && !scoped.some(binding => binding.workspace_id === options.workspaceId)) return false
      const visible = scoped.filter(binding => !options.workspaceId || binding.workspace_id === options.workspaceId)
      if (options.environmentId && visible.length && !visible.some(binding => binding.environment_id === options.environmentId)) return false
      const tools = toolRows.filter(tool => tool.server_id === server.id)
      return !query || [server.name, server.url ?? '', ...tools.map(tool => tool.name)].some(value => value.toLowerCase().includes(query))
    })
    const matched = await Promise.all(candidates.map(async server => ({ ...server, ...await this.readDetail(userId, server, options.workspaceId, managed(server)) })))
    return { ...(page ? { workspaceId: page.workspaceId, workspaceKind: page.workspaceKind, canShare: page.canShare } : {}), servers: matched, count: matched.length }
  }

  /** Owner-only changes that invalidate frozen references (the revision bump fails runs admitted
   * against the old scope). A tool switch is not one of them: see `setTool`. */
  private async write<T>(userId: string, serverId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withPluginTransaction(this.personal.pool, async client => {
      if (!(await client.query('SELECT 1 FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])).rowCount) throw new PluginError('mcpNotFound', 404)
      const result = await work(client)
      await client.query('UPDATE personal_mcp_servers SET revision=revision+1 WHERE id=$1', [serverId])
      return result
    })
  }

  /**
   * Turn one tool on or off, as Capy's per-tool switches do. The connection itself does not
   * change, so its revision stays and running tasks keep it: every call re-reads the switch
   * (`createPersonalMcpRuntime`), so a tool turned off is refused from the next call and one
   * turned on works from the next call. The owner may switch any tool; for a connection shared
   * to a team workspace, that workspace's admins may too (`workspaceId`). `expectedEnabled` is
   * the state the caller last saw; a different stored state is a concurrent change (409).
   */
  async setTool(userId: string, serverId: string, name: string, enabled: boolean, options: { workspaceId?: string; expectedEnabled?: boolean } = {}) {
    const toolName = mcpToolName.parse(name)
    if (typeof enabled !== 'boolean' || options.expectedEnabled !== undefined && typeof options.expectedEnabled !== 'boolean') throw new PluginError('invalidPluginInput', 400)
    const sharing = new WorkspaceMcpStore(this.personal.pool, this.personal.membership)
    await withPluginTransaction(this.personal.pool, async client => {
      // FOR SHARE: two switches on one connection do not wait on each other, but a share change,
      // a check or a credential change (all FOR UPDATE) does not interleave with one.
      const { rows: [server] } = await client.query<{ user_id: string }>('SELECT user_id FROM personal_mcp_servers WHERE id=$1 FOR SHARE', [serverId])
      if (!server) throw new PluginError('mcpNotFound', 404)
      if (server.user_id !== userId) {
        if (!options.workspaceId) throw new PluginError('mcpNotFound', 404)
        // Membership is in a separate database: read after the lock wait, inside the write.
        if (!await sharing.canManageSharedTools(userId, serverId, options.workspaceId, client)) throw new PluginError('workspaceAccessDenied', 403)
      }
      const { rows: [tool] } = await client.query<{ enabled: boolean }>('SELECT enabled FROM mcp_server_tools WHERE server_id=$1 AND tool_name=$2 FOR UPDATE', [serverId, toolName])
      if (!tool) throw new PluginError('mcpToolNotFound', 404)
      if (options.expectedEnabled !== undefined && tool.enabled !== options.expectedEnabled) throw new PluginError('mcpConnectionChanged', 409)
      if (tool.enabled !== enabled) await client.query('UPDATE mcp_server_tools SET enabled=$3,updated_at=now() WHERE server_id=$1 AND tool_name=$2', [serverId, toolName, enabled])
    })
    return this.detail(userId, serverId, options.workspaceId)
  }

  async setEnvironments(userId: string, serverId: string, raw: z.infer<typeof mcpEnvironmentSettings>) {
    const input = mcpEnvironmentSettings.parse(raw)
    await this.owned(userId, serverId)
    const sharing = new WorkspaceMcpStore(this.personal.pool, this.personal.membership)
    await sharing.workspace(userId, input.workspaceId)
    const members = await this.members()
    const { rows } = await members.query<{ id: string }>('SELECT id FROM workspace_environments WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "archivedAt" IS NULL', [input.workspaceId, input.environmentIds])
    if (rows.length !== input.environmentIds.length) throw new PluginError('environmentAccessDenied', 403)
    await this.write(userId, serverId, async client => {
      await sharing.workspace(userId, input.workspaceId)
      await client.query('DELETE FROM mcp_server_environments WHERE server_id=$1 AND workspace_id=$2', [serverId, input.workspaceId])
      for (const environmentId of input.environmentIds) await client.query(`INSERT INTO mcp_server_environments(server_id,workspace_id,environment_id) VALUES($1,$2,$3)`, [serverId, input.workspaceId, environmentId])
    })
    return this.detail(userId, serverId, input.workspaceId)
  }

  /** Enumerate all pages before changing the catalogue. A partial failed check
   * never removes the last confirmed tool list or resets a user's switches. */
  async check(userId: string, serverId: string, authorize = true): Promise<McpConnectionDetails> {
    const installation = await this.owned(userId, serverId)
    if (!installation.enabled) return this.detail(userId, serverId)
    if (installation.transport === 'stdio') throw new PluginError('mcpCheckRequiresDevice', 409)
    const tools: z.infer<typeof pageSchema>['tools'] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let failureReason: string | null = null
    let status: 'connected' | 'needs_connect' | 'check_failed' = 'connected'
    for (let page = 0; page < 20; page++) {
      const result = await runMcpCommand(async () => {
        const connection = await this.personal.mcpConnection(userId, serverId, installation.revision)
        if (connection.transport === 'stdio') throw new PluginError('mcpCheckRequiresDevice', 409)
        return { url: connection.url, transport: connection.transport, headers: connection.headers, secrets: [...Object.values(connection.headers), connection.url] }
      }, cursor ? { cursor } : {}, this.dependencies, {
        code: error => {
          const failure = mcpFailure(error, 'connect')
          status = failure.status === 401 || error instanceof PluginError && error.code === 'mcpNeedsConnect' ? 'needs_connect' : 'check_failed'
          failureReason = error instanceof PluginError ? error.code : [failure.reason, failure.status].filter(Boolean).join(':')
          return 'mcpUnavailable'
        },
      })
      const parsed = pageSchema.safeParse(result)
      if (!parsed.success) { if (status === 'connected') status = 'check_failed'; failureReason ??= 'invalidToolCatalogue'; break }
      tools.push(...parsed.data.tools)
      if (!parsed.data.nextCursor) break
      if (cursors.has(parsed.data.nextCursor) || page === 19) { status = 'check_failed'; failureReason = 'toolCatalogueIncomplete'; break }
      cursors.add(parsed.data.nextCursor); cursor = parsed.data.nextCursor
    }
    await withPluginTransaction(this.personal.pool, async client => {
      const { rows: [current] } = await client.query<{ revision: number }>('SELECT revision FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])
      if (!current || current.revision !== installation.revision) throw new PluginError('mcpConnectionChanged', 409)
      await saveToolSnapshot(client, serverId, status, failureReason, tools)
    })
    const checked = await this.detail(userId, serverId)
    if (checked.status !== 'needs_connect' || !authorize) return checked
    const authorized = await this.oauth.start(userId, serverId).catch(error => { if (!(error instanceof PluginError)) throw error })
    if (authorized?.status === 'connected') return this.check(userId, serverId, false)
    return this.detail(userId, serverId)
  }
}
