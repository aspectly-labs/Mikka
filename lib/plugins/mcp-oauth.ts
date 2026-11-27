import { createHash, randomBytes } from 'node:crypto'
import { auth, type OAuthAuthorizationServerInformation, type OAuthClientInformation, type OAuthClientMetadata, type OAuthClientProvider, type OAuthTokens } from '@ai-sdk/mcp'
import type { Pool, PoolClient } from 'pg'
import { openSecret, sealSecret } from '@/lib/secrets/crypto'
import { resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { runtimeEnv } from '@/lib/env/server'
import { PluginError } from './contracts'
import { publicMcpFetch } from './public-fetch'

type Credentials = {
  client?: OAuthClientInformation; tokens?: OAuthTokens; verifier?: string;
  authorizationServer?: OAuthAuthorizationServerInformation; redirectUrl: string;
  expiresAt?: number; authorizationUrl?: string; state?: string;
}
export type McpOAuthRow = { ciphertext: string; iv: string; key_version: number; state_digest: string | null; state_expires_at: Date | null }
type Row = McpOAuthRow
const aad = (userId: string, serverId: string) => JSON.stringify(['mcp-oauth', userId, serverId])
const digest = (state: string) => createHash('sha256').update(state).digest('hex')

/** SDK discovery may use a distinct authorization-server origin. Every request
 * still uses the existing DNS-pinned public transport and rejects redirects. */
export function mcpOAuthTransport() {
  const signal = AbortSignal.timeout(25_000)
  const transports = new Map<string, ReturnType<typeof publicMcpFetch>>()
  return {
    fetch: (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      let transport = transports.get(url.origin)
      if (!transport) { transport = publicMcpFetch(url.origin, signal); transports.set(url.origin, transport) }
      return transport.fetch(input, init)
    }) as typeof fetch,
    close: () => Promise.allSettled([...transports.values()].map(transport => transport.close())),
  }
}

/**
 * Where one OAuth account lives. The SDK flow below is the same for a person's own
 * connection and for a workspace server's shared or per-member account; only the
 * rows (and the AAD binding the ciphertext to them) differ.
 */
export type McpOAuthSlot = {
  /** Binds the ciphertext to its owner and server. */
  aad: string
  callbackUrl: () => string
  /** Lock the server row (FOR UPDATE) and return its endpoint. */
  server: (client: PoolClient) => Promise<{ url: string }>
  /** The account row, locked FOR UPDATE. */
  read: (client: PoolClient) => Promise<Row | undefined>
  save: (client: PoolClient, sealed: { ciphertext: string; iv: string; keyVersion: number }, stateDigest: string | null, stateExpires: Date | null) => Promise<void>
  /** Record the account's state; `revision` when a connection changed (not on a refresh failure). */
  status: (client: PoolClient, status: 'connected' | 'needs_connect', failure: string | null, revision: boolean) => Promise<void>
}

/** The SDK's native OAuth code/PKCE/discovery/refresh against one slot. */
export class McpOAuthFlow {
  constructor(readonly pool: Pool, readonly env: Readonly<Record<string, string | undefined>> = runtimeEnv(),
    readonly transport: () => { fetch: typeof fetch; close: () => Promise<unknown> } = mcpOAuthTransport) {}

  private read(row: Row, slot: McpOAuthSlot): Credentials {
    return JSON.parse(openSecret({ ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version }, slot.aad, this.env))
  }

  private async save(client: PoolClient, slot: McpOAuthSlot, data: Credentials, stateExpires: Date | null) {
    const sealed = sealSecret(JSON.stringify(data), slot.aad, this.env)
    await slot.save(client, sealed, data.state ? digest(data.state) : null, stateExpires)
  }

  private async locked<T>(slot: McpOAuthSlot, work: (client: PoolClient, url: string, row?: Row) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { url } = await slot.server(client)
      const result = await work(client, url, await slot.read(client))
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  private provider(data: Credentials): OAuthClientProvider {
    const metadata: OAuthClientMetadata = { client_name: 'Mikka', redirect_uris: [data.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
    return {
      redirectUrl: data.redirectUrl, clientMetadata: metadata,
      tokens: () => data.tokens,
      saveTokens: tokens => { data.tokens = { ...tokens, ...(tokens.refresh_token ? {} : data.tokens?.refresh_token ? { refresh_token: data.tokens.refresh_token } : {}) }; data.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000 },
      clientInformation: () => data.client,
      isClientInformationDynamicallyRegistered: () => true,
      saveClientInformation: value => { data.client = value },
      authorizationServerInformation: () => data.authorizationServer,
      saveAuthorizationServerInformation: value => { data.authorizationServer = value },
      saveCodeVerifier: value => { data.verifier = value },
      codeVerifier: () => { if (!data.verifier) throw new PluginError('mcpOAuthStateInvalid', 400); return data.verifier },
      redirectToAuthorization: url => { data.authorizationUrl = url.href },
      state: () => data.state ??= randomBytes(32).toString('base64url'),
      saveState: value => { data.state = value }, storedState: () => data.state,
      invalidateCredentials: (scope, context) => {
        if (scope === 'all' || scope === 'client') delete data.client
        if ((scope === 'all' || scope === 'tokens') && (!context || data.tokens?.access_token === context.tokens.access_token)) { delete data.tokens; delete data.expiresAt }
        if (scope === 'all' || scope === 'verifier') delete data.verifier
      },
    }
  }

  async startSlot(slot: McpOAuthSlot) {
    return this.locked(slot, async (client, url, row) => {
      const data = row ? this.read(row, slot) : { redirectUrl: slot.callbackUrl() }
      data.redirectUrl = slot.callbackUrl()
      data.state = randomBytes(32).toString('base64url')
      delete data.authorizationUrl
      const transport = this.transport()
      try { await auth(this.provider(data), { serverUrl: url, fetchFn: transport.fetch }) }
      // error-cause: OAuth SDK errors can contain token endpoint bodies and credentials.
      catch { throw new PluginError('mcpOAuthUnavailable', 503) }
      finally { await transport.close() }
      if (!data.authorizationUrl) { delete data.state; delete data.verifier }
      await this.save(client, slot, data, data.authorizationUrl ? new Date(Date.now() + 600_000) : null)
      await slot.status(client, data.authorizationUrl ? 'needs_connect' : 'connected', null, true)
      return { status: data.authorizationUrl ? 'needs_connect' as const : 'connected' as const, authorizationUrl: data.authorizationUrl ?? null }
    })
  }

  async callbackSlot(slot: McpOAuthSlot, input: { code: string; state: string; issuer?: string }) {
    if (!input.code || input.code.length > 4096 || input.state.length > 256) throw new PluginError('mcpOAuthStateInvalid', 400)
    return this.locked(slot, async (client, url, row) => {
      if (!row?.state_digest || row.state_digest !== digest(input.state) || !row.state_expires_at || row.state_expires_at.getTime() <= Date.now()) throw new PluginError('mcpOAuthStateInvalid', 400)
      const data = this.read(row, slot)
      const transport = this.transport()
      try { await auth(this.provider(data), { serverUrl: url, authorizationCode: input.code, callbackState: input.state, callbackIssuer: input.issuer, fetchFn: transport.fetch }) }
      // error-cause: OAuth SDK errors can contain authorization codes and token endpoint bodies.
      catch { throw new PluginError('mcpOAuthExchangeFailed', 400) }
      finally { await transport.close() }
      delete data.verifier; delete data.state; delete data.authorizationUrl
      await this.save(client, slot, data, null)
      await slot.status(client, 'connected', null, true)
      return { status: 'connected' as const, authorizationUrl: null }
    })
  }

  /** A row lock serializes token rotation. Credentials never leave this method
   * except the bearer handed to an already-authorized native MCP connection. */
  async accessTokenSlot(slot: McpOAuthSlot): Promise<string> {
    const result = await this.locked(slot, async (client, url, row) => {
      const reconnect = async () => {
        await slot.status(client, 'needs_connect', 'oauthReconnectRequired', false)
        return null
      }
      if (!row) return reconnect()
      const data = this.read(row, slot)
      if (data.tokens?.access_token && (data.expiresAt === undefined || data.expiresAt > Date.now() + 30_000)) return data.tokens.access_token
      if (!data.tokens?.refresh_token) return reconnect()
      const transport = this.transport()
      let transientFailure = false
      let status: Awaited<ReturnType<typeof auth>>
      try {
        status = await auth(this.provider(data), { serverUrl: url, fetchFn: async (input, init) => {
          try {
            const response = await transport.fetch(input, init)
            if (response.status === 429 || response.status >= 500) transientFailure = true
            return response
          } catch (error) {
            transientFailure = true
            throw error
          }
        } })
      } catch {
        // error-cause: OAuth SDK errors can contain token endpoint bodies.
        if (transientFailure) throw new PluginError('mcpOAuthUnavailable', 503)
        return reconnect()
      } finally { await transport.close() }
      if (status !== 'AUTHORIZED' && transientFailure) throw new PluginError('mcpOAuthUnavailable', 503)
      await this.save(client, slot, data, data.authorizationUrl ? new Date(Date.now() + 600_000) : null)
      if (data.authorizationUrl || !data.tokens?.access_token) return reconnect()
      return data.tokens.access_token
    })
    if (!result) throw new PluginError('mcpNeedsConnect', 409)
    return result
  }

  /** The pending sign-in link of an account row the caller already selected. */
  pendingAuthorizationUrl(row: Row | undefined, slot: Pick<McpOAuthSlot, 'aad'>): string | null {
    if (!row?.state_expires_at || row.state_expires_at.getTime() <= Date.now()) return null
    return (JSON.parse(openSecret({ ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version }, slot.aad, this.env)) as Credentials).authorizationUrl ?? null
  }
}

/** A person's own connection (personal_mcp_servers / personal_mcp_oauth). */
export class McpOAuthStore extends McpOAuthFlow {
  callbackUrl(serverId: string) {
    const origin = resolveAppOrigin(this.env)
    if (!origin) throw new PluginError('mcpOAuthOriginUnavailable', 503)
    return new URL(withBasePath(`/api/integrations/mcp/${serverId}/oauth/callback`), origin).href
  }

  slot(userId: string, serverId: string): McpOAuthSlot {
    return {
      aad: aad(userId, serverId),
      callbackUrl: () => this.callbackUrl(serverId),
      server: async client => {
        const { rows: [server] } = await client.query<{ url: string; transport: string }>('SELECT url,transport FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])
        if (!server) throw new PluginError('mcpNotFound', 404)
        if (server.transport === 'stdio') throw new PluginError('mcpOAuthNotSupported', 400)
        return server
      },
      read: async client => (await client.query<Row>('SELECT * FROM personal_mcp_oauth WHERE server_id=$1 FOR UPDATE', [serverId])).rows[0],
      save: async (client, sealed, stateDigest, stateExpires) => {
        await client.query(`INSERT INTO personal_mcp_oauth(server_id,ciphertext,iv,key_version,state_digest,state_expires_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(server_id) DO UPDATE SET ciphertext=$2,iv=$3,key_version=$4,state_digest=$5,state_expires_at=$6,updated_at=now()`,
        [serverId, sealed.ciphertext, sealed.iv, sealed.keyVersion, stateDigest, stateExpires])
      },
      status: async (client, status, failure, revision) => {
        if (revision) await client.query(`UPDATE personal_mcp_servers SET oauth_enabled=true,connection_status=$3,check_failure=$4,revision=revision+1 WHERE id=$1 AND user_id=$2`, [serverId, userId, status, failure])
        else await client.query(`UPDATE personal_mcp_servers SET connection_status=$2,check_failure=$3 WHERE id=$1`, [serverId, status, failure])
      },
    }
  }

  start(userId: string, serverId: string) { return this.startSlot(this.slot(userId, serverId)) }
  callback(userId: string, serverId: string, input: { code: string; state: string; issuer?: string }) { return this.callbackSlot(this.slot(userId, serverId), input) }
  accessToken(userId: string, serverId: string) { return this.accessTokenSlot(this.slot(userId, serverId)) }

  async authorizationUrl(userId: string, serverId: string): Promise<string | null> {
    const { rows: [row] } = await this.pool.query<Row>(`SELECT o.* FROM personal_mcp_oauth o JOIN personal_mcp_servers s ON s.id=o.server_id
      WHERE s.id=$1 AND s.user_id=$2 AND o.state_expires_at>now()`, [serverId, userId])
    return this.pendingAuthorizationUrl(row, { aad: aad(userId, serverId) })
  }
}
