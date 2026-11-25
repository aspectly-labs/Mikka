import type { ApiSession } from '@/lib/api-auth'
import { ACTION_ERROR_CODES } from '@/lib/action-result'
import * as cronAuth from '@/lib/cron-auth'
import * as desktopAuth from '@/lib/desktop-auth'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import * as freshSessionModule from '@/lib/fresh-session'
import * as requestLog from '@/lib/request-log'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { WorkspaceError } from '@/lib/workspace-error'
import { selectedWorkspaceId, workspaceSelection } from '@/lib/workspace-selection'

export const ROUTE_AUTH_MODES = [
  'public',
  'session',
  'mobile-or-session',
  'human-session-only',
  'cron-secret',
  'webhook-signature',
] as const

export const ROUTE_ORIGIN_POLICIES = [
  'any',
  'same-origin-or-desktop',
  'native-mobile-allowed',
] as const

export const ROUTE_WORKSPACE_POLICIES = [
  'none',
  'member',
  'admin',
  'pat-scoped',
] as const

export type SessionAuthMode = 'session' | 'mobile-or-session' | 'human-session-only'
export type NonSessionAuthMode = 'public' | 'cron-secret' | 'webhook-signature'
export type RouteAuthMode = (typeof ROUTE_AUTH_MODES)[number]
export type RouteOriginPolicy = (typeof ROUTE_ORIGIN_POLICIES)[number]
export type RouteWorkspacePolicy = (typeof ROUTE_WORKSPACE_POLICIES)[number]

export type RouteHandlerParams = Record<string, string | string[] | undefined>
export type RouteAuthFailureReason = 'unauthenticated' | 'patNotAllowed' | 'humanSessionRequired'
export type RouteHandlerContext<P extends RouteHandlerParams = RouteHandlerParams> = {
  params: Promise<P>
}
export type RouteHandler<P extends RouteHandlerParams = Record<string, string>> = (
  request: Request,
  context?: RouteHandlerContext<P>,
) => Promise<Response>

export type WebhookVerifyResult<TWebhook = unknown> =
  | { ok: true; payload?: TWebhook }
  | { ok: false; status?: number; error?: string }
  | Response

export type WebhookVerifier<TWebhook = unknown> = (
  request: Request,
) => WebhookVerifyResult<TWebhook> | Promise<WebhookVerifyResult<TWebhook>>

export type ResolvedWorkspaceContext = {
  id: string
  name: string
  kind: 'personal' | 'team'
  role: 'admin' | 'member'
  choices: Array<{ id: string; name: string; kind: 'personal' | 'team' }>
  currentUserId: string
  currentUser: { name: string; email: string; image: string | null }
}

type LoadedWorkspaceContext = {
  workspace: { id: string; name: string; kind: 'personal' | 'team' }
  choices: Array<{ id: string; name: string; kind: 'personal' | 'team' }>
  currentUserId: string
  role: 'admin' | 'member'
  currentUser: { name: string; email: string; image: string | null }
}

type RouteSpecBase<P extends RouteHandlerParams> = {
  /** Route template for structured logging (`withRequestLog`), e.g. `/api/mobile/preferences`. */
  route?: string
  /** Explicit origin / CSRF boundary. */
  origin: RouteOriginPolicy
  /** Enforces `writeAllowed` when true (in addition to stricter `origin` policies). */
  write?: boolean
  /** Forces database-fresh session reads (`disableCookieCache: true` inside `withFreshSession`). */
  freshSession?: boolean
  /** Optional extractor for routes whose target workspace ID comes from URL params or query string. */
  workspaceId?: (input: { request: Request; params: P }) => string | null | undefined
  /**
   * Optional legacy refusal formatter for auth failures (must return a 401 or 403 Response;
   * any non-401/403 return value is ignored fail-closed so auth can never be bypassed).
   */
  onAuthFailure?: (reason: RouteAuthFailureReason) => Response
}

export type RouteSpec<
  Auth extends RouteAuthMode = RouteAuthMode,
  Workspace extends RouteWorkspacePolicy = RouteWorkspacePolicy,
  P extends RouteHandlerParams = Record<string, string>,
  TWebhook = unknown,
> = RouteSpecBase<P> & {
  auth: Auth
  workspace: Auth extends SessionAuthMode ? Workspace : 'none'
} & (Auth extends 'webhook-signature'
  ? { verifyWebhook: WebhookVerifier<TWebhook> }
  : { verifyWebhook?: never })

export type RouteContext<
  Auth extends RouteAuthMode,
  Workspace extends RouteWorkspacePolicy,
  P extends RouteHandlerParams = Record<string, string>,
  TWebhook = unknown,
> = {
  request: Request
  params: P
  session: Auth extends SessionAuthMode ? ApiSession : null
  user: Auth extends SessionAuthMode ? ApiSession['user'] : null
  /** Pinned workspace ID when authenticated by a Personal Access Token; undefined otherwise. */
  tokenWorkspaceId: string | undefined
  /** Validated target workspace ID from `spec.workspaceId`, `x-mikka-workspace-id`, or loaded context. */
  requestedWorkspaceId: string | null
  /** Resolved authorized workspace when `workspace` is `'member'` or `'admin'`; null otherwise. */
  workspace: Auth extends SessionAuthMode
    ? Workspace extends 'member' | 'admin'
      ? ResolvedWorkspaceContext
      : null
    : null
  /** Enforces PAT workspace fencing; throws `WorkspaceError('workspaceAccessDenied')` on mismatch. */
  assertWorkspaceAllowed: (workspaceId: string) => void
  /** Verified payload returned by `verifyWebhook` for `auth: 'webhook-signature'`. */
  webhook: Auth extends 'webhook-signature' ? TWebhook | undefined : undefined
}

export type RouteGuardDependencies = {
  getSession: (options: {
    headers: Headers
    query?: { disableCookieCache?: boolean; disableRefresh?: boolean }
  }) => Promise<ApiSession | null>
  mobileUser: (request: Request) => Promise<ApiSession['user'] | null>
  writeAllowed: (request: Request) => boolean
  desktopSameOrigin: (request: Request) => boolean
  cronUnauthorized: (request: Request) => Promise<Response | null>
  loadWorkspaceContext: (
    requestedId?: string,
    authenticatedUser?: ApiSession['user'],
  ) => Promise<LoadedWorkspaceContext>
  noteLogUser: (userId: string | null | undefined) => void
  mobileAppOrigin: string
}

export const NO_STORE_PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' } as const
export const NO_STORE_PUBLIC_HEADERS = { 'Cache-Control': 'no-store' } as const

const PAT_BEARER_PATTERN = /^Bearer\s+mkp_/i
const SESSION_AUTH_SET = new Set<string>(['session', 'mobile-or-session', 'human-session-only'])
const AUTH_MODE_SET = new Set<string>(ROUTE_AUTH_MODES)
const ORIGIN_POLICY_SET = new Set<string>(ROUTE_ORIGIN_POLICIES)
const WORKSPACE_POLICY_SET = new Set<string>(ROUTE_WORKSPACE_POLICIES)
const ACTION_ERROR_CODE_SET = new Set<string>(ACTION_ERROR_CODES)
const FORBIDDEN_WORKSPACE_CODES = new Set<string>([
  'workspaceAccessDenied',
  'workspaceMembershipSuspended',
  'taskWorkspaceTransferDenied',
  'scheduleWorkspaceAccessDenied',
  'teamIssueAccessDenied',
])

export function routeJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = NO_STORE_PRIVATE_HEADERS,
): Response {
  return Response.json(body, { status, headers })
}

/** Pure mobile-compatible write origin check matching `lib/mobile-api.ts#writeAllowed`. */
export function checkMobileWriteOrigin(
  request: Request,
  options: { appOrigin?: string; mobileAppOrigin?: string } = {},
): boolean {
  const mobilePrefix = options.mobileAppOrigin ?? 'mikka://'
  const origin = request.headers.get('origin') ?? request.headers.get('expo-origin')
  return !origin
    || origin === new URL(request.url).origin
    || (Boolean(options.appOrigin) && origin === options.appOrigin)
    || origin.startsWith(mobilePrefix)
}

export function extractTokenWorkspaceId(session: ApiSession | null | undefined): string | undefined {
  if (!session) return undefined
  const principal = session.user[enterprisePrincipal]
  return session.tokenWorkspaceId
    ?? session.user[tokenWorkspace]
    ?? (principal?.kind === 'pat' ? principal.workspaceId : undefined)
}

export function isPatSession(session: ApiSession | null | undefined): boolean {
  if (!session) return false
  return Boolean(
    session.tokenId
    || session.tokenWorkspaceId
    || session.user[tokenWorkspace]
    || session.user[enterprisePrincipal]?.kind === 'pat',
  )
}

/** Converts a `WorkspaceError` into a canonical 403/409 JSON response without echoing untrusted error text. */
export function workspaceErrorResponse(error: WorkspaceError): Response {
  const knownCode = ACTION_ERROR_CODE_SET.has(error.code) ? error.code : null
  if (FORBIDDEN_WORKSPACE_CODES.has(error.code)) {
    return routeJson({ error: knownCode ?? 'workspaceAccessDenied' }, 403)
  }
  if (error.code === 'billingAutoRechargeUnavailable') {
    return routeJson(
      {
        error: 'billingAutoRechargeUnavailable',
        state: 'provider_unsupported',
        provider: 'stripe_managed_payments',
      },
      409,
    )
  }
  return routeJson({ error: knownCode ?? 'generic' }, 409)
}

function sessionFromUser(user: ApiSession['user']): ApiSession {
  const principal: EnterprisePrincipal | undefined = user[enterprisePrincipal]
  const patWorkspaceId = user[tokenWorkspace]
    ?? (principal?.kind === 'pat' ? principal.workspaceId : undefined)
  const patTokenId = principal?.kind === 'pat' ? principal.tokenId : undefined
  const sessionId = principal?.kind === 'session'
    ? principal.sessionId
    : patTokenId
      ? `pat:${patTokenId}`
      : 'mobile-session'
  return {
    user,
    session: { id: sessionId },
    ...(patWorkspaceId ? { tokenWorkspaceId: patWorkspaceId } : {}),
    ...(patTokenId ? { tokenId: patTokenId } : {}),
  }
}

const defaultDependencies: RouteGuardDependencies = {
  getSession: async options => {
    const apiAuth = await import('@/lib/api-auth')
    return apiAuth.auth.api.getSession(options)
  },
  mobileUser: async request => {
    const mobileApi = await import('@/lib/mobile-api')
    return mobileApi.mobileUser(request)
  },
  writeAllowed: request => {
    // Synchronous fallback is never hit before `checkOrigin` lazily primes mobileApi when needed;
    // replaced below via async origin helper so module mocks of `@/lib/mobile-api` are honored.
    return desktopAuth.desktopSameOriginRequest(request)
  },
  desktopSameOrigin: request => desktopAuth.desktopSameOriginRequest(request),
  cronUnauthorized: request => cronAuth.cronUnauthorized(request),
  loadWorkspaceContext: async (requestedId, authenticatedUser) => {
    const workspaceAccess = await import('@/lib/workspace-access')
    return workspaceAccess.loadWorkspaceContext(requestedId, authenticatedUser)
  },
  noteLogUser: userId => {
    if (typeof requestLog.noteLogUser === 'function') requestLog.noteLogUser(userId)
  },
  mobileAppOrigin: 'mikka://',
}

function authFailureResponse<P extends RouteHandlerParams>(
  spec: RouteSpecBase<P>,
  reason: RouteAuthFailureReason,
): Response {
  if (spec.onAuthFailure) {
    const custom = spec.onAuthFailure(reason)
    if (custom instanceof Response && (custom.status === 401 || custom.status === 403)) {
      return custom
    }
  }
  return reason === 'unauthenticated'
    ? routeJson({ error: 'authRequired' }, 401)
    : routeJson({ error: reason }, 403)
}

async function isNativeMobileOriginAllowed(
  request: Request,
  deps: Partial<RouteGuardDependencies>,
): Promise<boolean> {
  let allowed: boolean
  let mobilePrefix = deps.mobileAppOrigin ?? 'mikka://'
  if (deps.writeAllowed) {
    allowed = deps.writeAllowed(request)
  } else {
    const mobileApi = await import('@/lib/mobile-api')
    allowed = mobileApi.writeAllowed(request)
    const authConfig = await import('@/lib/auth-config')
    mobilePrefix = authConfig.MOBILE_APP_ORIGIN
  }
  if (!allowed) return false

  const origin = request.headers.get('origin')
  const expoOrigin = request.headers.get('expo-origin')
  // Reject cross-site browser requests even when Origin is omitted, unless the caller carries the native mobile scheme.
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (
    secFetchSite === 'cross-site'
    && !(origin?.startsWith(mobilePrefix) || expoOrigin?.startsWith(mobilePrefix))
  ) {
    return false
  }
  // When both Origin and Expo-Origin are sent, verify Expo-Origin is not a foreign origin either.
  if (origin && expoOrigin) {
    const synthetic = new Request(request.url, {
      method: request.method,
      headers: { 'expo-origin': expoOrigin },
    })
    if (deps.writeAllowed) {
      if (!deps.writeAllowed(synthetic)) return false
    } else {
      const mobileApi = await import('@/lib/mobile-api')
      if (!mobileApi.writeAllowed(synthetic)) return false
    }
  }
  return true
}

function isSameOriginOrDesktopAllowed(
  request: Request,
  deps: Partial<RouteGuardDependencies>,
): boolean {
  const check = deps.desktopSameOrigin ?? defaultDependencies.desktopSameOrigin
  if (!check(request)) return false
  const expoOrigin = request.headers.get('expo-origin')
  if (expoOrigin !== null && expoOrigin !== new URL(request.url).origin) return false
  return true
}

function validateSpec(spec: {
  auth: string
  origin: string
  workspace: string
  verifyWebhook?: unknown
}): void {
  if (!AUTH_MODE_SET.has(spec.auth)) {
    throw new TypeError(`defineRoute: invalid auth mode "${String(spec.auth)}"`)
  }
  if (!ORIGIN_POLICY_SET.has(spec.origin)) {
    throw new TypeError(`defineRoute: invalid origin policy "${String(spec.origin)}"`)
  }
  if (!WORKSPACE_POLICY_SET.has(spec.workspace)) {
    throw new TypeError(`defineRoute: invalid workspace policy "${String(spec.workspace)}"`)
  }
  if (!SESSION_AUTH_SET.has(spec.auth) && spec.workspace !== 'none') {
    throw new TypeError(
      `defineRoute: auth "${spec.auth}" requires workspace "none" (got "${spec.workspace}")`,
    )
  }
  if (spec.auth === 'webhook-signature' && typeof spec.verifyWebhook !== 'function') {
    throw new TypeError('defineRoute: auth "webhook-signature" requires a verifyWebhook function')
  }
}

/**
 * Creates a `defineRoute` factory bound to custom dependencies (for deterministic unit tests).
 * Production routes should import `defineRoute` directly.
 */
export function createRouteGuard(deps: Partial<RouteGuardDependencies> = {}) {
  const getSession = deps.getSession ?? defaultDependencies.getSession
  const mobileUser = deps.mobileUser ?? defaultDependencies.mobileUser
  const checkCronUnauthorized = deps.cronUnauthorized ?? defaultDependencies.cronUnauthorized
  const loadWorkspace = deps.loadWorkspaceContext ?? defaultDependencies.loadWorkspaceContext
  const logUser = deps.noteLogUser ?? defaultDependencies.noteLogUser

  return function defineRoute<
    Auth extends RouteAuthMode,
    Workspace extends RouteWorkspacePolicy,
    P extends RouteHandlerParams = Record<string, string>,
    TWebhook = unknown,
  >(
    spec: RouteSpec<Auth, Workspace, P, TWebhook>,
    handler: (ctx: RouteContext<Auth, Workspace, P, TWebhook>) => Promise<Response> | Response,
  ): RouteHandler<P> {
    validateSpec(spec)

    const execute: RouteHandler<P> = async (request, context) => {
      // 1. Origin / CSRF boundary (fail fast before any session or database I/O).
      if (spec.origin === 'same-origin-or-desktop') {
        if (!isSameOriginOrDesktopAllowed(request, deps)) {
          return routeJson({ error: 'originNotAllowed' }, 403)
        }
      } else if (spec.origin === 'native-mobile-allowed' || spec.write === true) {
        if (!(await isNativeMobileOriginAllowed(request, deps))) {
          return routeJson({ error: 'originNotAllowed' }, 403)
        }
      }

      // 2. Authentication boundary.
      let session: ApiSession | null = null
      let webhookPayload: TWebhook | undefined

      if (spec.auth === 'cron-secret') {
        const refused = await checkCronUnauthorized(request)
        if (refused) return refused
      } else if (spec.auth === 'webhook-signature') {
        const verify = spec.verifyWebhook
        if (!verify) return routeJson({ error: 'webhookVerifierRequired' }, 401, NO_STORE_PUBLIC_HEADERS)
        const verified = await verify(request)
        if (verified instanceof Response) return verified
        if (!verified.ok) {
          return routeJson(
            { error: verified.error ?? 'invalidWebhookSignature' },
            verified.status ?? 401,
            NO_STORE_PUBLIC_HEADERS,
          )
        }
        webhookPayload = verified.payload
      } else if (spec.auth === 'human-session-only') {
        // Explicit PAT bearer is refused immediately; ambient browser cookies cannot rescue it.
        if (PAT_BEARER_PATTERN.test(request.headers.get('authorization') ?? '')) {
          return authFailureResponse(spec, 'patNotAllowed')
        }
        const { humanSessionHeaders } = await import('@/lib/desktop-rpc/handler')
        const headers = humanSessionHeaders(request)
        if (!headers) {
          logUser(null)
          return authFailureResponse(spec, 'unauthenticated')
        }
        session = await getSession({
          headers,
          ...(spec.freshSession ? { query: { disableCookieCache: true } } : {}),
        })
        logUser(session?.user?.id)
        if (!session?.user) {
          return authFailureResponse(spec, 'unauthenticated')
        }
        if (isPatSession(session)) {
          return authFailureResponse(spec, 'patNotAllowed')
        }
        const principal = session.user[enterprisePrincipal]
        if (principal && principal.kind !== 'session') {
          return authFailureResponse(spec, 'humanSessionRequired')
        }
      } else if (spec.auth === 'mobile-or-session') {
        if (spec.freshSession) {
          session = await getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
          })
          logUser(session?.user?.id)
        } else {
          const user = await mobileUser(request)
          logUser(user?.id)
          session = user ? sessionFromUser(user) : null
        }
        if (!session?.user) {
          return authFailureResponse(spec, 'unauthenticated')
        }
      } else if (spec.auth === 'session') {
        session = await getSession({
          headers: request.headers,
          ...(spec.freshSession ? { query: { disableCookieCache: true } } : {}),
        })
        logUser(session?.user?.id)
        if (!session?.user) {
          return authFailureResponse(spec, 'unauthenticated')
        }
      }

      // 3. Params, workspace resolution, PAT fencing, and handler execution.
      // Any WorkspaceError thrown during workspace resolution or inside the handler
      // becomes a canonical 403/409 JSON payload rather than an unhandled 500.
      try {
        const params = (context?.params ? await context.params : {}) as P
        const tokenWorkspaceId = extractTokenWorkspaceId(session)
        const normalizedTokenWorkspaceId = tokenWorkspaceId?.toLowerCase()
        const assertWorkspaceAllowed = (workspaceId: string): void => {
          if (normalizedTokenWorkspaceId && normalizedTokenWorkspaceId !== workspaceId.toLowerCase()) {
            throw new WorkspaceError('workspaceAccessDenied')
          }
        }

        let requestedWorkspaceId: string | null = null
        let workspace: ResolvedWorkspaceContext | null = null

        if (spec.workspace !== 'none') {
          const selection = workspaceSelection(request.headers)
          if (selection.present && !selection.workspaceId) {
            throw new WorkspaceError('workspaceAccessDenied')
          }
          const rawExplicit = spec.workspaceId ? spec.workspaceId({ request, params }) : undefined
          let explicitWorkspaceId: string | null = null
          if (rawExplicit !== undefined && rawExplicit !== null && rawExplicit !== '') {
            explicitWorkspaceId = selectedWorkspaceId(rawExplicit)
            if (!explicitWorkspaceId) {
              throw new WorkspaceError('workspaceAccessDenied')
            }
          }

          // Enforce PAT workspace fencing before hitting workspace lookups or handler business logic.
          if (normalizedTokenWorkspaceId) {
            if (explicitWorkspaceId && explicitWorkspaceId !== normalizedTokenWorkspaceId) {
              throw new WorkspaceError('workspaceAccessDenied')
            }
            if (selection.workspaceId && selection.workspaceId !== normalizedTokenWorkspaceId) {
              throw new WorkspaceError('workspaceAccessDenied')
            }
          }

          requestedWorkspaceId = explicitWorkspaceId ?? selection.workspaceId ?? null

          if (spec.workspace === 'member' || spec.workspace === 'admin') {
            if (!session?.user) {
              return routeJson({ error: 'authRequired' }, 401)
            }
            const loaded = await loadWorkspace(requestedWorkspaceId ?? undefined, session.user)
            if (normalizedTokenWorkspaceId && loaded.workspace.id.toLowerCase() !== normalizedTokenWorkspaceId) {
              throw new WorkspaceError('workspaceAccessDenied')
            }
            if (
              selection.present
              && selection.workspaceId
              && !loaded.choices.some(choice => choice.id.toLowerCase() === selection.workspaceId)
            ) {
              throw new WorkspaceError('workspaceAccessDenied')
            }
            if (spec.workspace === 'admin' && loaded.role !== 'admin') {
              throw new WorkspaceError('workspaceAccessDenied')
            }
            workspace = {
              id: loaded.workspace.id,
              name: loaded.workspace.name,
              kind: loaded.workspace.kind,
              role: loaded.role,
              choices: loaded.choices,
              currentUserId: loaded.currentUserId,
              currentUser: loaded.currentUser,
            }
            requestedWorkspaceId = requestedWorkspaceId ?? loaded.workspace.id
          }
        }

        const routeCtx = {
          request,
          params,
          session,
          user: session?.user ?? null,
          tokenWorkspaceId,
          requestedWorkspaceId,
          workspace,
          assertWorkspaceAllowed,
          webhook: webhookPayload,
        } as RouteContext<Auth, Workspace, P, TWebhook>

        return await handler(routeCtx)
      } catch (error) {
        if (error instanceof WorkspaceError) {
          return workspaceErrorResponse(error)
        }
        throw error
      }
    }

    const withFreshness: RouteHandler<P> = spec.freshSession
      ? (request, context) => (
          typeof freshSessionModule.withFreshSession === 'function'
            ? freshSessionModule.withFreshSession(() => execute(request, context))
            : execute(request, context)
        )
      : execute

    return spec.route && typeof requestLog.withRequestLog === 'function'
      ? requestLog.withRequestLog(spec.route, withFreshness)
      : withFreshness
  }
}

/**
 * Declarative API route guard factory.
 *
 * Every guarded route must explicitly declare `auth`, `origin`, and `workspace`.
 * Handles origin checks (including `mikka://` native mobile clients), session/PAT/cron/webhook
 * authentication, PAT workspace fencing, workspace membership/admin resolution, and canonical
 * `WorkspaceError` -> 403/409 JSON conversion so workspace refusals never surface as HTTP 500.
 */
export const defineRoute = createRouteGuard()
