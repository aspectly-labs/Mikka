import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { billingCatalogViewSchema, DEFAULT_CREDIT_CONVERSION, deriveMachineSkuCatalog } from '@/lib/billing/catalog-client'
import { WorkspaceError } from '@/lib/workspace-error'

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222'
const FOREIGN_WORKSPACE = '33333333-3333-4333-8333-333333333333'

let currentUser: { id: string; name: string; email: string } | null = {
  id: 'user-1',
  name: 'Catalog Tester',
  email: 'tester@example.invalid',
}
let currentTokenWorkspaceId: string | undefined
const resolvedWorkspaceCalls: Array<string | null | undefined> = []

let routeModule: typeof import('./route')

before(async () => {
  mock.module('@/lib/api-auth', {
    namedExports: {
      auth: {
        api: {
          getSession: async () => (
            currentUser
              ? {
                  user: currentUser,
                  session: { id: 'session-catalog-test' },
                  ...(currentTokenWorkspaceId ? { tokenWorkspaceId: currentTokenWorkspaceId } : {}),
                }
              : null
          ),
        },
      },
    },
  })

  mock.module('@/lib/workspace-access', {
    namedExports: {
      WorkspaceError,
      loadWorkspaceContext: async (requestedId?: string) => {
        if (requestedId === FOREIGN_WORKSPACE) {
          throw new WorkspaceError('workspaceAccessDenied')
        }
        const id = requestedId ?? currentTokenWorkspaceId ?? WORKSPACE_A
        return {
          workspace: { id, name: 'Test Workspace', kind: 'team' as const },
          choices: [
            { id: WORKSPACE_A, name: 'Workspace A', kind: 'team' as const },
            { id: WORKSPACE_B, name: 'Workspace B', kind: 'team' as const },
          ],
          currentUserId: currentUser?.id ?? 'user-1',
          role: 'admin' as const,
          currentUser: { name: 'Catalog Tester', email: 'tester@example.invalid', image: null },
        }
      },
    },
  })

  mock.module('@/lib/billing/catalog', {
    namedExports: {
      resolveBillingCatalog: async (options: { workspaceId?: string | null } = {}) => {
        resolvedWorkspaceCalls.push(options.workspaceId)
        return {
          currency: 'usd',
          configured: true,
          plans: [{
            id: 'pro',
            plan: 'pro' as const,
            name: 'Pro',
            stripePriceId: 'price_resource_pro',
            amountCents: 2000,
            currency: 'usd',
            interval: 'month' as const,
            includedCreditCents: 2000,
            includedPoints: 2000,
            seatModel: 'per_workspace' as const,
            active: true,
          }],
          creditConversion: DEFAULT_CREDIT_CONVERSION,
          machineSkus: deriveMachineSkuCatalog(),
          activeOffer: options.workspaceId === WORKSPACE_A
            ? {
                id: 'intro-week-1',
                kind: 'intro_period' as const,
                planId: 'pro',
                introAmountCents: 100,
                introInterval: 'week' as const,
                regularAmountCents: 2000,
                regularInterval: 'month' as const,
                introCreditCents: 500,
                endsAt: '2026-12-01T00:00:00Z',
              }
            : null,
          fetchedAt: '2026-11-15T12:00:00.000Z',
        }
      },
    },
  })

  routeModule = await import('./route')
})

test('GET /api/billing/catalog refuses unauthenticated callers with 401 and private no-store', async () => {
  const prior = currentUser
  currentUser = null
  resolvedWorkspaceCalls.length = 0
  try {
    const response = await routeModule.GET(new Request('https://mikka.example/api/billing/catalog'))
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: 'authRequired' })
    assert.equal(resolvedWorkspaceCalls.length, 0)
  } finally {
    currentUser = prior
  }
})

test('GET /api/billing/catalog returns validated catalog for default and explicit workspaces with Cache-Control: private, no-store', async () => {
  resolvedWorkspaceCalls.length = 0
  const defaultRes = await routeModule.GET(new Request('https://mikka.example/api/billing/catalog'))
  assert.equal(defaultRes.status, 200)
  assert.equal(defaultRes.headers.get('cache-control'), 'private, no-store')
  const defaultBody = billingCatalogViewSchema.parse(await defaultRes.json())
  assert.equal(defaultBody.configured, true)
  assert.equal(defaultBody.plans.length, 1)
  assert.equal(defaultBody.activeOffer?.id, 'intro-week-1')
  assert.deepEqual(resolvedWorkspaceCalls, [WORKSPACE_A])

  const explicitRes = await routeModule.GET(
    new Request(`https://mikka.example/api/billing/catalog?workspace=${WORKSPACE_B}`),
  )
  assert.equal(explicitRes.status, 200)
  assert.equal(explicitRes.headers.get('cache-control'), 'private, no-store')
  const explicitBody = billingCatalogViewSchema.parse(await explicitRes.json())
  assert.equal(explicitBody.activeOffer, null)
  assert.deepEqual(resolvedWorkspaceCalls, [WORKSPACE_A, WORKSPACE_B])
})

test('GET /api/billing/catalog rejects invalid workspace query, unauthorized workspaces, and cross-workspace PATs with 403', async () => {
  resolvedWorkspaceCalls.length = 0

  const invalidRes = await routeModule.GET(
    new Request('https://mikka.example/api/billing/catalog?workspace=not-a-uuid'),
  )
  assert.equal(invalidRes.status, 403)
  assert.equal(invalidRes.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await invalidRes.json(), { error: 'workspaceAccessDenied' })
  assert.equal(resolvedWorkspaceCalls.length, 0)

  const foreignRes = await routeModule.GET(
    new Request(`https://mikka.example/api/billing/catalog?workspace=${FOREIGN_WORKSPACE}`),
  )
  assert.equal(foreignRes.status, 403)
  assert.equal(foreignRes.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await foreignRes.json(), { error: 'workspaceAccessDenied' })
  assert.equal(resolvedWorkspaceCalls.length, 0)

  currentTokenWorkspaceId = WORKSPACE_A
  try {
    const crossPatRes = await routeModule.GET(
      new Request(`https://mikka.example/api/billing/catalog?workspace=${WORKSPACE_B}`),
    )
    assert.equal(crossPatRes.status, 403)
    assert.equal(crossPatRes.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await crossPatRes.json(), { error: 'workspaceAccessDenied' })
    assert.equal(resolvedWorkspaceCalls.length, 0)

    const allowedPatRes = await routeModule.GET(
      new Request(`https://mikka.example/api/billing/catalog?workspace=${WORKSPACE_A}`),
    )
    assert.equal(allowedPatRes.status, 200)
    assert.equal(allowedPatRes.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(resolvedWorkspaceCalls, [WORKSPACE_A])
  } finally {
    currentTokenWorkspaceId = undefined
  }
})
