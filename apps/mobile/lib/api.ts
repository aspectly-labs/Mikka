import { Platform } from 'react-native'
import { secureStorage as SecureStore } from './secure-storage'
import { validTraceparent } from '@mikka/protocol/trace-context'
import { hostedApiUpgrade } from '@mikka/protocol/version'
import { authClient } from '@/lib/auth'
import { currentAccount } from '@/lib/config'
import { sessionRefused } from '@/lib/session'
import { accessGeneration, prepareAccess, recoverAccess } from './refresh'
import { apiCache } from './api-cache'
import { mobileTraceHeaders } from './tracing'
import { accountStorageKey } from './server-store'
import { workspaceFromCookie } from './workspace-cookie'
import { presenceScope } from './presence-scope'
import { requireMobileUpdate } from './startup'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly traceId?: string, cause?: unknown) {
    super(code, { cause })
  }
}

export class ApiTransportError extends Error {
  constructor(readonly reason: 'credentials' | 'network' | 'timeout' | 'invalid_response', cause: unknown, readonly traceId?: string) {
    super(reason, { cause })
  }
}

type ApiRequest = { method?: string; body?: unknown; timeoutMs?: number; diagnostics?: { headers?: Record<string, string> }; headers?: Record<string, string> }
export const apiConnection = () => ({ account: currentAccount(), client: authClient })
export type ApiConnection = ReturnType<typeof apiConnection>

/**
 * The workspace the person picked in Settings; the server reads it as its `mikka-workspace` cookie. On web that cookie
 * is the saved pick (saveWorkspace writes it), so a pushed task's read (lib/task-push.ts) can compare against it.
 */
export async function savedWorkspace(account = currentAccount()): Promise<string | null> {
  if (Platform.OS === 'web') return typeof document === 'undefined' ? null : workspaceFromCookie(document.cookie)
  return SecureStore.getItemAsync(accountStorageKey(account.id, 'workspace'))
}

const workspaceListeners = new Set<() => void>()

/** Runs `listener` whenever the person switches workspace; returns the unsubscribe. */
export function onWorkspaceChange(listener: () => void) {
  workspaceListeners.add(listener)
  return () => { workspaceListeners.delete(listener) }
}

/** The account and cache context an action started in (lib/task-push.ts): it may write only while both are current. */
export type WorkspaceOwner = { account: string; context: number }

/**
 * Saves the workspace pick for the current account. With `owner`, nothing is written unless that account and context
 * are still current. Returns the context this save's own switch produced, or null when it wrote nothing or the
 * context moved while it was writing (then no screen is told to reload).
 */
export async function saveWorkspace(id: string, owner?: WorkspaceOwner): Promise<number | null> {
  const account = currentAccount(), context = apiCache.context()
  if (owner && (owner.account !== account.id || owner.context !== context)) return null
  if (Platform.OS === 'web') document.cookie = `mikka-workspace=${id}; path=/; samesite=lax`
  else await SecureStore.setItemAsync(accountStorageKey(account.id, 'workspace'), id)
  // Every screen's data belongs to the workspace: reload it now, not at the next poll.
  const committed = currentAccount().id === account.id && apiCache.commit(context, () => { for (const listener of workspaceListeners) listener() })
  return committed ? apiCache.context() : null
}

/**
 * A request to Mikka's API as the signed-in person. On iOS the session cookie
 * comes from the keychain; on web the browser sends its own cookies. On iOS a
 * 401 first renews the session with the refresh credential and replays the
 * request once; a 401 that stays signs out only when the auth server confirms
 * the session is gone.
 */
/** The headers that sign a request as the person (iOS: the session and workspace cookies; the web's browser sends its own). */
export async function authHeaders(connection: ApiConnection = apiConnection(), workspace?: string | null): Promise<Record<string, string>> {
  const tracing = mobileTraceHeaders()
  if (Platform.OS === 'web') return tracing
  if (workspace === undefined) workspace = await savedWorkspace(connection.account)
  return { ...tracing, cookie: [await connection.client.getCookie(), workspace ? `mikka-workspace=${workspace}` : ''].filter(Boolean).join('; ') }
}

/** A request that has not answered by then fails, so nothing waits on it forever (a send shows 重试). */
export const REQUEST_TIMEOUT_MS = 30_000

/** `headers` adds request preferences (a task push's x-mikka-workspace-id, lib/task-push.ts); the sign-in headers always win. */
export async function api<T>(path: string, init: ApiRequest = {}, connection: ApiConnection = apiConnection()): Promise<T> {
  const context = apiCache.context()
  const account = connection.account.id
  // An access session about to end is renewed first (lib/refresh.ts); a failure there changes nothing.
  await prepareAccess(account).catch(() => undefined)
  const generation = accessGeneration(account)
  // The workspace this request was made in: a replay after a renewed session keeps it, even if the person switched since.
  let workspace: string | null | undefined
  const sign = async () => {
    try {
      if (workspace === undefined && Platform.OS !== 'web') workspace = await savedWorkspace(connection.account)
      return await authHeaders(connection, workspace)
    }
    catch (error) {
      if (init.diagnostics) throw new ApiTransportError('credentials', error)
      throw error
    }
  }
  let authentication = await sign()
  const traceId = validTraceparent(authentication.traceparent) ? authentication.traceparent.slice(3, 35) : undefined
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  let controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const send = (authentication: Record<string, string>) => {
    const headers: Record<string, string> = { ...init.diagnostics?.headers, accept: 'application/json', ...init.headers, ...authentication }
    if (path === '/api/mobile/threads' && (init.method ?? 'GET').toUpperCase() === 'GET' && currentAccount().id === account) {
      const proof = presenceScope.token(context)
      if (proof) headers['x-mikka-presence-scope'] = proof
    }
    if (path === '/api/rpc') headers['x-mikka-rpc'] = '1'
    if (path === '/api/rpc' || (path === '/api/inbox' && init.method === 'POST')) {
      // Native fetch has no browser Origin. Bind the cookie and origin to the
      // same saved connection even if the person switches servers in flight.
      if (Platform.OS !== 'web') headers.origin = new URL(connection.account.server.url).origin
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    return fetch(`${connection.account.server.url}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      redirect: 'error',
      signal: controller.signal,
    }).catch(error => {
      if (init.diagnostics) throw new ApiTransportError(controller.signal.aborted ? 'timeout' : 'network', error, traceId)
      throw error
    })
  }
  try {
    let response = await send(authentication)
    if (!init.diagnostics) clearTimeout(timer)
    // A response for a previous identity must not sign the current person out.
    if (response.status === 401 && currentAccount().id === account) {
      // Every 401 at once shares one rotation; the request is replayed once with the renewed cookie.
      const recovery = await recoverAccess(account, generation).catch(() => 'unavailable' as const)
      if (recovery === 'rotated' && currentAccount().id === account) {
        clearTimeout(timer)
        controller = new AbortController()
        timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
        authentication = await sign()
        response = await send(authentication)
        if (!init.diagnostics) clearTimeout(timer)
      }
      // Still refused: only the auth server, asked about this very session, signs the person out (lib/session.ts).
      // A refresh credential the server could not be asked about (no network, 5xx) keeps the person signed in.
      if (response.status === 401 && recovery !== 'unavailable' && currentAccount().id === account) apiCache.commit(context, () => { void sessionRefused(authentication.cookie ?? null) })
    }
    if (response.status === 204) return undefined as T
    const data = await response.json().catch(error => {
      if (response.ok && init.diagnostics) throw new ApiTransportError(controller.signal.aborted ? 'timeout' : 'invalid_response', error, traceId)
      return null
    }) as (T & { error?: string }) | null
    if (!response.ok) {
      const upgrade = response.status === 426 ? hostedApiUpgrade(data) : null
      if (upgrade && currentAccount().id === account) requireMobileUpdate(connection.account.server.url)
      throw new ApiError(response.status, data?.error ?? `http${response.status}`, traceId, upgrade?.cause)
    }
    return data as T
  } finally { clearTimeout(timer) }
}
