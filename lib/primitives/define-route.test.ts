import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApiSession } from '@/lib/api-auth'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { sessionMustBeFresh } from '@/lib/fresh-session'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { WorkspaceError } from '@/lib/workspace-error'
import {
  checkMobileWriteOrigin,
  createRouteGuard,
  defineRoute,
  resolveApiAuthSession,
  routeJson,
  type RouteGuardDependencies,
} from './define-route'

const ORIGIN = 'https://api.mikka.test'
const CONFIGURED_ORIGIN = 'https://app.mikka.test'
const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'

function makeHumanSession(userId = 'user-1', sessionId = 'sess-1'): ApiSession {
  const user: ApiSession['user'] = {
    id: userId,
    name: 'Alice',
    email: 'alice@example.test',
    image: null,
  }
  const principal: EnterprisePrincipal = { kind: 'session', sessionId }
  Object.defineProperty(user, enterprisePrincipal, { value: principal, configurable: true })
  return { user, session: { id: sessionId } }
}

function makePatSession(workspaceId = WS_A, userId = 'user-1', tokenId = 'tok-1'): ApiSession {
  const user: ApiSession['user'] = {
    id: userId,
    name: 'Alice',
    email: 'alice@example.test',
    image: null,
  }
  const principal: EnterprisePrincipal = { kind: 'pat', tokenId, workspaceId }
  Object.defineProperty(user, tokenWorkspace, { value: workspaceId, configurable: true })
  Object.defineProperty(user, enterprisePrincipal, { value: principal, configurable: true })
  return {
    user,
    session: { id: `pat:${tokenId}` },
    tokenWorkspaceId: workspaceId,
    tokenId,
  }
}

function makeWorkspaceLoaded(
  id = WS_A,
  role: 'admin' | 'member' = 'member',
  choices = [{ id, name: 'Team', kind: 'team' as const }],
) {
  return {
    workspace: { id, name: 'Team', kind: 'team' as const },
    choices,
    currentUserId: 'user-1',
    role,
    currentUser: { name: 'Alice', email: 'alice@example.test', image: null },
  }
}

function makeHarness(overrides: Partial<RouteGuardDependencies> = {}) {
  const loggedUsers: Array<string | null | undefined> = []
  const sessionCalls: Array<{ headers: Headers; query?: { disableCookieCache?: boolean } }> = []
  const workspaceCalls: Array<{ requestedId?: string; userId?: string }> = []
  let currentSession: ApiSession | null = makeHumanSession()
  let loadedWorkspace = makeWorkspaceLoaded()

  const guard = createRouteGuard({
    getSession: async options => {
      sessionCalls.push({ headers: new Headers(options.headers), query: options.query })
      return currentSession
    },
    mobileUser: async () => currentSession?.user ?? null,
    writeAllowed: request =>
      checkMobileWriteOrigin(request, { appOrigin: CONFIGURED_ORIGIN, mobileAppOrigin: 'mikka://' }),
    loadWorkspaceContext: async (requestedId, user) => {
      workspaceCalls.push({ requestedId, userId: user?.id })
      return loadedWorkspace
    },
    noteLogUser: userId => {
      loggedUsers.push(userId)
    },
    ...overrides,
  })

  return {
    guard,
    loggedUsers,
    sessionCalls,
    workspaceCalls,
    setSession(next: ApiSession | null) {
      currentSession = next
    },
    setLoadedWorkspace(next: ReturnType<typeof makeWorkspaceLoaded>) {
      loadedWorkspace = next
    },
  }
}

function req(
  path = '/api/test',
  init: { method?: string; headers?: HeadersInit; body?: BodyInit } = {},
) {
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  })
}

test('spec validation fails fast on invalid auth/origin/workspace combinations', () => {
  assert.throws(
    () =>
      defineRoute(
        // @ts-expect-error public routes cannot require workspace membership
        { auth: 'public', origin: 'any', workspace: 'member' },
        () => routeJson({ ok: true }),
      ),
    /requires workspace "none"/,
  )
  assert.throws(
    () =>
      defineRoute(
        // @ts-expect-error cron routes cannot require pat-scoped workspace
        { auth: 'cron-secret', origin: 'any', workspace: 'pat-scoped' },
        () => routeJson({ ok: true }),
      ),
    /requires workspace "none"/,
  )
  assert.throws(
    () =>
      defineRoute(
        // @ts-expect-error webhook routes require verifyWebhook
        { auth: 'webhook-signature', origin: 'any', workspace: 'none' },
        () => routeJson({ ok: true }),
      ),
    /requires a verifyWebhook function/,
  )
})

test('public route with origin: any allows unauthenticated cross-origin requests', async () => {
  const handler = defineRoute(
    { auth: 'public', origin: 'any', workspace: 'none' },
    async ctx => {
      assert.equal(ctx.user, null)
      assert.equal(ctx.session, null)
      assert.equal(ctx.workspace, null)
      return routeJson({ status: 'ok' })
    },
  )
  const response = await handler(req('/api/health', { headers: { origin: 'https://foreign.test' } }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
})

test('origin: native-mobile-allowed allows mikka://, expo-origin, appOrigin, same-origin, and absent origin while blocking foreign origins', async () => {
  const harness = makeHarness()
  let reached = 0
  const handler = harness.guard(
    { auth: 'mobile-or-session', origin: 'native-mobile-allowed', workspace: 'none', write: true },
    async ({ user }) => {
      reached++
      return routeJson({ userId: user.id })
    },
  )

  const allowedHeaders: HeadersInit[] = [
    {},
    { origin: ORIGIN },
    { origin: CONFIGURED_ORIGIN },
    { origin: 'mikka://app' },
    { 'expo-origin': 'mikka://app' },
    { origin: 'mikka://app', 'expo-origin': 'mikka://app' },
  ]
  for (const headers of allowedHeaders) {
    const res = await handler(req('/api/mobile/test', { method: 'POST', headers }))
    assert.equal(res.status, 200)
  }
  assert.equal(reached, allowedHeaders.length)

  const deniedHeaders: HeadersInit[] = [
    { origin: 'https://evil.test' },
    { origin: 'null' },
    { 'expo-origin': 'https://evil.test' },
    { origin: ORIGIN, 'expo-origin': 'https://evil.test' },
    { 'sec-fetch-site': 'cross-site' },
  ]
  for (const headers of deniedHeaders) {
    const res = await handler(req('/api/mobile/test', { method: 'POST', headers }))
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { error: 'originNotAllowed' })
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
  }
  assert.equal(reached, allowedHeaders.length, 'denied origins never invoke the handler')
})

test('origin: same-origin-or-desktop allows desktop/same-origin and rejects mikka:// and cross-site browsers', async () => {
  const harness = makeHarness()
  const handler = harness.guard(
    { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
    async ({ user }) => routeJson({ userId: user.id }),
  )

  for (const headers of [
    {},
    { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'none' },
  ] as HeadersInit[]) {
    assert.equal((await handler(req('/api/desktop/test', { method: 'POST', headers }))).status, 200)
  }

  for (const headers of [
    { origin: 'mikka://app' },
    { 'expo-origin': 'mikka://app' },
    { origin: 'https://evil.test' },
    { 'sec-fetch-site': 'cross-site' },
  ] as HeadersInit[]) {
    const res = await handler(req('/api/desktop/test', { method: 'POST', headers }))
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { error: 'originNotAllowed' })
  }
})

test('origin: any with write: true still enforces writeAllowed', async () => {
  const harness = makeHarness()
  const handler = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'none', write: true },
    async () => routeJson({ ok: true }),
  )

  assert.equal((await handler(req('/api/test', { method: 'POST', headers: { origin: 'mikka://app' } }))).status, 200)
  const denied = await handler(req('/api/test', { method: 'POST', headers: { origin: 'https://evil.test' } }))
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { error: 'originNotAllowed' })
})

test('auth: session and mobile-or-session return 401 when unauthenticated and record user logs when authenticated', async () => {
  const harness = makeHarness()
  harness.setSession(null)
  const sessionRoute = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'none' },
    async ({ user }) => routeJson({ id: user.id }),
  )
  const mobileRoute = harness.guard(
    { auth: 'mobile-or-session', origin: 'native-mobile-allowed', workspace: 'none' },
    async ({ user }) => routeJson({ id: user.id }),
  )

  for (const route of [sessionRoute, mobileRoute]) {
    const res = await route(req())
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'authRequired' })
  }

  harness.setSession(makeHumanSession('user-42'))
  const ok = await mobileRoute(req())
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { id: 'user-42' })
  assert.equal(harness.loggedUsers.at(-1), 'user-42')
})

test('freshSession: true sets sessionMustBeFresh and requests disableCookieCache', async () => {
  const harness = makeHarness()
  let observedFresh = false
  const handler = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'none', freshSession: true },
    async () => {
      observedFresh = sessionMustBeFresh()
      return routeJson({ fresh: observedFresh })
    },
  )

  assert.equal(sessionMustBeFresh(), false)
  const res = await handler(req())
  assert.equal(res.status, 200)
  assert.equal(observedFresh, true)
  assert.equal(harness.sessionCalls.at(-1)?.query?.disableCookieCache, true)
  assert.equal(sessionMustBeFresh(), false)
})

test('auth: human-session-only refuses PAT bearers (even with cookie), PAT sessions, and delegated principals', async () => {
  const harness = makeHarness()
  let handlerCalls = 0
  const handler = harness.guard(
    { auth: 'human-session-only', origin: 'same-origin-or-desktop', workspace: 'none' },
    async ({ user }) => {
      handlerCalls++
      return routeJson({ id: user.id })
    },
  )

  // Explicit PAT bearer is refused immediately, even if accompanied by a valid browser cookie.
  const patBearerWithCookie = await handler(
    req('/api/sensitive', {
      headers: {
        authorization: `Bearer mkp_${'a'.repeat(43)}`,
        cookie: 'better-auth.session_token=valid',
      },
    }),
  )
  assert.equal(patBearerWithCookie.status, 403)
  assert.deepEqual(await patBearerWithCookie.json(), { error: 'patNotAllowed' })

  // Service/refresh bearers and anonymous calls get 401.
  for (const headers of [
    {},
    { authorization: `Bearer mksvc_${'a'.repeat(43)}` },
    { authorization: `Bearer mkmr_${'a'.repeat(43)}` },
  ] as HeadersInit[]) {
    const res = await handler(req('/api/sensitive', { headers }))
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'authRequired' })
  }

  // Defense in depth: if getSession somehow yields a PAT session, refuse with 403.
  harness.setSession(makePatSession(WS_A))
  const patSessionRes = await handler(
    req('/api/sensitive', { headers: { cookie: 'better-auth.session_token=valid' } }),
  )
  assert.equal(patSessionRes.status, 403)
  assert.deepEqual(await patSessionRes.json(), { error: 'patNotAllowed' })

  // Non-session enterprise principal (e.g. OAuth delegation) is refused with 403.
  const delegated = makeHumanSession()
  Object.defineProperty(delegated.user, enterprisePrincipal, {
    value: { kind: 'delegation', credentialId: 'cred-1', credentialKind: 'oauth' } satisfies EnterprisePrincipal,
    configurable: true,
  })
  harness.setSession(delegated)
  const delegatedRes = await handler(
    req('/api/sensitive', { headers: { cookie: 'better-auth.session_token=valid' } }),
  )
  assert.equal(delegatedRes.status, 403)
  assert.deepEqual(await delegatedRes.json(), { error: 'humanSessionRequired' })
  assert.equal(handlerCalls, 0)

  // Valid human cookie session succeeds.
  harness.setSession(makeHumanSession('human-1'))
  const okCookie = await handler(
    req('/api/sensitive', { headers: { cookie: 'better-auth.session_token=valid' } }),
  )
  assert.equal(okCookie.status, 200)
  assert.deepEqual(await okCookie.json(), { id: 'human-1' })

  // Valid desktop human signed bearer succeeds and strips ambient cookies.
  const desktopToken = 'd'.repeat(64)
  const okDesktop = await handler(
    req('/api/sensitive', {
      headers: { authorization: `Bearer ${desktopToken}`, cookie: 'ambient=1' },
    }),
  )
  assert.equal(okDesktop.status, 200)
  assert.equal(harness.sessionCalls.at(-1)?.headers.get('cookie'), null)
  assert.equal(harness.sessionCalls.at(-1)?.headers.get('authorization'), `Bearer ${desktopToken}`)
  assert.equal(handlerCalls, 2)
})

test('auth: cron-secret enforces CRON_SECRET presence and constant-time bearer match', async () => {
  const previous = process.env.CRON_SECRET
  const handler = defineRoute(
    { auth: 'cron-secret', origin: 'any', workspace: 'none' },
    async () => routeJson({ swept: true }),
  )
  try {
    delete process.env.CRON_SECRET
    assert.equal((await handler(req('/api/cron/test'))).status, 503)

    process.env.CRON_SECRET = 'cron-fixture-secret-0123456789'
    assert.equal((await handler(req('/api/cron/test'))).status, 401)
    assert.equal(
      (await handler(req('/api/cron/test', { headers: { authorization: 'Bearer wrong' } }))).status,
      401,
    )
    const ok = await handler(
      req('/api/cron/test', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }),
    )
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { swept: true })
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  }
})

test('auth: webhook-signature runs verifier and forwards verified payload or canonical rejection', async () => {
  const handler = defineRoute(
    {
      auth: 'webhook-signature',
      origin: 'any',
      workspace: 'none',
      verifyWebhook: async request => {
        const sig = request.headers.get('x-sig')
        if (sig === 'raw-413') return new Response('too large', { status: 413 })
        if (sig !== 'valid') return { ok: false, status: 401, error: 'invalidSignature' }
        return { ok: true, payload: { eventId: 'evt-99' } }
      },
    },
    async ({ webhook }) => routeJson({ received: webhook?.eventId }),
  )

  const bad = await handler(req('/api/webhooks/test', { method: 'POST', headers: { 'x-sig': 'bad' } }))
  assert.equal(bad.status, 401)
  assert.deepEqual(await bad.json(), { error: 'invalidSignature' })
  assert.equal(bad.headers.get('cache-control'), 'no-store')

  const large = await handler(req('/api/webhooks/test', { method: 'POST', headers: { 'x-sig': 'raw-413' } }))
  assert.equal(large.status, 413)

  const ok = await handler(req('/api/webhooks/test', { method: 'POST', headers: { 'x-sig': 'valid' } }))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { received: 'evt-99' })
})

test('workspace: pat-scoped enforces PAT workspace fencing on header, params, and assertWorkspaceAllowed', async () => {
  const harness = makeHarness()
  let handlerCalls = 0
  const handler = harness.guard(
    {
      auth: 'mobile-or-session',
      origin: 'native-mobile-allowed',
      workspace: 'pat-scoped',
      workspaceId: ({ params }) => params.workspaceId,
    },
    async ({ tokenWorkspaceId, requestedWorkspaceId, assertWorkspaceAllowed }) => {
      handlerCalls++
      const target = new URL('https://example.test').searchParams.get('unused') ?? WS_A
      assertWorkspaceAllowed(requestedWorkspaceId ?? target)
      return routeJson({ tokenWorkspaceId: tokenWorkspaceId ?? null, requestedWorkspaceId })
    },
  )

  // PAT pinned to WS_A calling WS_B via params -> 403 before handler runs.
  harness.setSession(makePatSession(WS_A))
  const wrongParam = await handler(req(`/api/workspaces/${WS_B}`), {
    params: Promise.resolve({ workspaceId: WS_B }),
  })
  assert.equal(wrongParam.status, 403)
  assert.deepEqual(await wrongParam.json(), { error: 'workspaceAccessDenied' })

  // PAT pinned to WS_A with mismatched x-mikka-workspace-id header -> 403 before handler runs.
  const wrongHeader = await handler(
    req('/api/items', { headers: { 'x-mikka-workspace-id': WS_B } }),
  )
  assert.equal(wrongHeader.status, 403)
  assert.deepEqual(await wrongHeader.json(), { error: 'workspaceAccessDenied' })

  // Malformed x-mikka-workspace-id header -> 403 before handler runs.
  const badUuid = await handler(
    req('/api/items', { headers: { 'x-mikka-workspace-id': 'not-a-uuid' } }),
  )
  assert.equal(badUuid.status, 403)
  assert.equal(handlerCalls, 0)

  // PAT pinned to WS_A calling WS_A -> 200.
  const matching = await handler(req(`/api/workspaces/${WS_A}`), {
    params: Promise.resolve({ workspaceId: WS_A }),
  })
  assert.equal(matching.status, 200)
  assert.deepEqual(await matching.json(), { tokenWorkspaceId: WS_A, requestedWorkspaceId: WS_A })
  assert.equal(handlerCalls, 1)

  // Handler-level assertWorkspaceAllowed mismatch catches WorkspaceError -> 403.
  const bodyFenceRoute = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'pat-scoped' },
    async ({ assertWorkspaceAllowed }) => {
      assertWorkspaceAllowed(WS_B)
      return routeJson({ ok: true })
    },
  )
  const fenced = await bodyFenceRoute(req())
  assert.equal(fenced.status, 403)
  assert.deepEqual(await fenced.json(), { error: 'workspaceAccessDenied' })

  // Unscoped browser session is not fenced by PAT workspace.
  harness.setSession(makeHumanSession())
  assert.equal((await bodyFenceRoute(req())).status, 200)
})

test('workspace: member and admin resolve workspace context and enforce role boundaries', async () => {
  const harness = makeHarness()
  harness.setLoadedWorkspace(makeWorkspaceLoaded(WS_A, 'member'))

  const memberRoute = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'member' },
    async ({ workspace }) => routeJson({ workspaceId: workspace.id, role: workspace.role }),
  )
  const adminRoute = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'admin' },
    async ({ workspace }) => routeJson({ workspaceId: workspace.id, role: workspace.role }),
  )

  const memberOk = await memberRoute(req())
  assert.equal(memberOk.status, 200)
  assert.deepEqual(await memberOk.json(), { workspaceId: WS_A, role: 'member' })

  const adminDenied = await adminRoute(req())
  assert.equal(adminDenied.status, 403)
  assert.deepEqual(await adminDenied.json(), { error: 'workspaceAccessDenied' })

  harness.setLoadedWorkspace(makeWorkspaceLoaded(WS_A, 'admin'))
  const adminOk = await adminRoute(req())
  assert.equal(adminOk.status, 200)
  assert.deepEqual(await adminOk.json(), { workspaceId: WS_A, role: 'admin' })
})

test('WorkspaceError is always mapped to canonical 403/409 JSON and never leaks as HTTP 500', async () => {
  const harness = makeHarness()

  const cases: Array<[string, number, Record<string, unknown>]> = [
    ['workspaceAccessDenied', 403, { error: 'workspaceAccessDenied' }],
    ['workspaceMembershipSuspended', 403, { error: 'workspaceMembershipSuspended' }],
    ['workspaceLastAdmin', 409, { error: 'workspaceLastAdmin' }],
    ['billingPolicyChanged', 409, { error: 'billingPolicyChanged' }],
    [
      'billingAutoRechargeUnavailable',
      409,
      {
        error: 'billingAutoRechargeUnavailable',
        state: 'provider_unsupported',
        provider: 'stripe_managed_payments',
      },
    ],
    ['untrusted internal secret detail', 409, { error: 'generic' }],
  ]

  for (const [code, expectedStatus, expectedBody] of cases) {
    const handler = harness.guard(
      { auth: 'session', origin: 'any', workspace: 'none' },
      async () => {
        throw new WorkspaceError(code)
      },
    )
    const res = await handler(req())
    assert.equal(res.status, expectedStatus, code)
    assert.deepEqual(await res.json(), expectedBody, code)
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
  }

  // Non-WorkspaceError bugs still propagate so request logging and error monitoring observe them.
  const unexpected = new Error('boom')
  const crashingRoute = harness.guard(
    { auth: 'session', origin: 'any', workspace: 'none' },
    async () => {
      throw unexpected
    },
  )
  await assert.rejects(() => crashingRoute(req()), error => error === unexpected)
})

test('onAuthFailure customizes 401/403 refusal envelopes fail-closed and optional catch-all params type-check', async () => {
  const harness = makeHarness()
  harness.setSession(null)

  const governanceRoute = harness.guard(
    {
      auth: 'session',
      origin: 'any',
      workspace: 'none',
      onAuthFailure: () => Response.json(
        { error: { code: 'governance_denied', detail: 'access_denied' } },
        { status: 403, headers: { 'cache-control': 'private, no-store' } },
      ),
    },
    async () => routeJson({ ok: true }),
  )
  const denied = await governanceRoute(req('/api/me/security'))
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { error: { code: 'governance_denied', detail: 'access_denied' } })

  // A non-401/403 return from onAuthFailure is ignored fail-closed so auth can never be bypassed.
  const bypassAttempt = harness.guard(
    {
      auth: 'session',
      origin: 'any',
      workspace: 'none',
      onAuthFailure: () => routeJson({ leaked: true }, 200),
    },
    async () => routeJson({ ok: true }),
  )
  const closed = await bypassAttempt(req('/api/me/security'))
  assert.equal(closed.status, 401)
  assert.deepEqual(await closed.json(), { error: 'authRequired' })

  // Optional catch-all route params (`[[...resource]]`) are accepted by RouteHandlerParams.
  const scimRoute = harness.guard<'public', 'none', { connectionId: string; resource?: string[] }>(
    { auth: 'public', origin: 'any', workspace: 'none' },
    async ({ params }) => routeJson({ connectionId: params.connectionId, resource: params.resource ?? [] }),
  )
  const scimRes = await scimRoute(req('/api/scim/v2/conn-1'), {
    params: Promise.resolve({ connectionId: 'conn-1' }),
  })
  assert.equal(scimRes.status, 200)
  assert.deepEqual(await scimRes.json(), { connectionId: 'conn-1', resource: [] })
})

test('disableRefresh, fail-closed onOriginFailure/onAuthError, and zero-arg public routes work as specified', async () => {
  const harness = makeHarness()

  // disableRefresh forwards disableRefresh: true without renewing session cookies.
  const nonRenewing = harness.guard(
    { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true, disableRefresh: true },
    async ({ user }) => routeJson({ id: user.id }),
  )
  const ok = await nonRenewing(req('/api/account/deletion', { method: 'POST', headers: { origin: ORIGIN } }))
  assert.equal(ok.status, 200)
  assert.deepEqual(harness.sessionCalls.at(-1)?.query, { disableCookieCache: true, disableRefresh: true })

  // onOriginFailure preserves route-specific 401/403 contracts BEFORE auth runs and ignores bypass attempts fail-closed.
  const customOrigin = harness.guard(
    {
      auth: 'public',
      origin: 'same-origin-or-desktop',
      workspace: 'none',
      onOriginFailure: () => Response.json({ error: 'originRejected' }, { status: 403, headers: { 'x-custom': '1' } }),
    },
    async () => routeJson({ ok: true }),
  )
  const rejected = await customOrigin(req('/api/device-tokens/x/revoke', { method: 'POST', headers: { origin: 'https://evil.example' } }))
  assert.equal(rejected.status, 403)
  assert.deepEqual(await rejected.json(), { error: 'originRejected' })
  assert.equal(rejected.headers.get('x-custom'), '1')

  const sessionCallsBeforeForeignOrigin = harness.sessionCalls.length
  const legacy401Origin = harness.guard(
    {
      auth: 'human-session-only',
      origin: 'same-origin-or-desktop',
      workspace: 'none',
      freshSession: true,
      write: true,
      onOriginFailure: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
      onAuthFailure: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    },
    async () => routeJson({ ok: true }),
  )
  const foreignOriginRefused = await legacy401Origin(
    req('/api/agent-cli-policy', {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie: 'better-auth.session_token=abc' },
    }),
  )
  assert.equal(foreignOriginRefused.status, 401)
  assert.deepEqual(await foreignOriginRefused.json(), { error: 'unauthorized' })
  assert.equal(harness.sessionCalls.length, sessionCallsBeforeForeignOrigin, 'foreign-origin writes must fail before session lookup')

  const badOriginHook = harness.guard(
    {
      auth: 'public',
      origin: 'same-origin-or-desktop',
      workspace: 'none',
      onOriginFailure: () => routeJson({ bypass: true }, 200),
    },
    async () => routeJson({ ok: true }),
  )
  const closedOrigin = await badOriginHook(req('/api/x', { method: 'POST', headers: { origin: 'https://evil.example' } }))
  assert.equal(closedOrigin.status, 403)
  assert.deepEqual(await closedOrigin.json(), { error: 'originNotAllowed' })

  // onAuthError maps thrown session-lookup outages to custom 5xx and rethrows if a non-5xx bypass is returned.
  const outage = new Error('session store unavailable')
  const outageGuard = createRouteGuard({
    getSession: async () => { throw outage },
    noteLogUser: () => {},
  })
  const secretRoute = outageGuard(
    {
      auth: 'session',
      origin: 'any',
      workspace: 'none',
      onAuthError: () => Response.json({ error: 'secretsUnavailable' }, { status: 503 }),
    },
    async () => routeJson({ ok: true }),
  )
  const unavailable = await secretRoute(req('/api/secrets/delivery'))
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'secretsUnavailable' })

  const badAuthErrHook = outageGuard(
    {
      auth: 'session',
      origin: 'any',
      workspace: 'none',
      onAuthError: () => routeJson({ bypass: true }, 200),
    },
    async () => routeJson({ ok: true }),
  )
  await assert.rejects(() => badAuthErrHook(req('/api/secrets/delivery')), error => error === outage)

  // Public routes with origin: 'any', workspace: 'none', no write/route allow zero-arg invocation.
  const zeroArgRoute = harness.guard(
    { auth: 'public', origin: 'any', workspace: 'none' },
    () => new Response('ok', { status: 200 }),
  )
  assert.equal((await zeroArgRoute()).status, 200)
})

test('onWorkspaceError preserves anti-enumeration 404 fail-closed and resolveApiAuthSession handles getApiSession-only mocks', async () => {
  const harness = makeHarness()
  let handlerCalls = 0

  const antiEnumRoute = harness.guard(
    {
      auth: 'mobile-or-session',
      origin: 'any',
      workspace: 'pat-scoped',
      onWorkspaceError: () => routeJson({ error: 'issueNotFound' }, 404),
    },
    async () => {
      handlerCalls++
      throw new WorkspaceError('workspaceAccessDenied')
    },
  )

  // Malformed x-mikka-workspace-id fails before handler runs and returns the route's anti-enumeration 404.
  const badHeader = await antiEnumRoute(req('/api/mobile/tasks/t1', {
    headers: { 'x-mikka-workspace-id': 'not-a-workspace' },
  }))
  assert.equal(badHeader.status, 404)
  assert.deepEqual(await badHeader.json(), { error: 'issueNotFound' })
  assert.equal(handlerCalls, 0)

  // Cross-workspace PAT mismatch also returns 404 before handler runs.
  harness.setSession(makePatSession(WS_A))
  const patMismatch = await antiEnumRoute(req('/api/mobile/tasks/t1', {
    headers: { 'x-mikka-workspace-id': WS_B },
  }))
  assert.equal(patMismatch.status, 404)
  assert.deepEqual(await patMismatch.json(), { error: 'issueNotFound' })
  assert.equal(handlerCalls, 0)

  // Handler-thrown WorkspaceError also routes through onWorkspaceError.
  harness.setSession(makeHumanSession())
  const handlerRefused = await antiEnumRoute(req('/api/mobile/tasks/t1'))
  assert.equal(handlerRefused.status, 404)
  assert.deepEqual(await handlerRefused.json(), { error: 'issueNotFound' })
  assert.equal(handlerCalls, 1)

  // A non-403/404/409 return from onWorkspaceError is ignored fail-closed.
  const bypassAttempt = harness.guard(
    {
      auth: 'session',
      origin: 'any',
      workspace: 'pat-scoped',
      onWorkspaceError: () => routeJson({ bypass: true }, 200),
    },
    async () => routeJson({ ok: true }),
  )
  const closed = await bypassAttempt(req('/api/mobile/tasks/t1', {
    headers: { 'x-mikka-workspace-id': 'not-a-workspace' },
  }))
  assert.equal(closed.status, 403)
  assert.deepEqual(await closed.json(), { error: 'workspaceAccessDenied' })

  // resolveApiAuthSession supports both `{ auth: { api: { getSession } } }` and `{ getApiSession }` shapes.
  const expected = makeHumanSession('user-mock')
  const viaAuth = await resolveApiAuthSession(
    { auth: { api: { getSession: async () => expected } } },
    { headers: new Headers() },
  )
  assert.equal(viaAuth?.user.id, 'user-mock')

  const viaDirect = await resolveApiAuthSession(
    { getApiSession: async () => expected },
    { headers: new Headers() },
  )
  assert.equal(viaDirect?.user.id, 'user-mock')

  await assert.rejects(
    () => resolveApiAuthSession({ auth: {} }, { headers: new Headers() }),
    /api-auth session getter unavailable/,
  )
})
