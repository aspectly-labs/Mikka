import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { billingManagementPath } from '../lib/billing/management-path'
import { billingManagementRequest } from '../lib/billing/management-client'
import { currentMonth, usageMonth } from '../lib/usage/month'

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222'

let actor: { id: string; tokenWorkspaceId?: string } | null = { id: 'owner-1' }
const sessionOptionsLog: Array<{ query?: { disableCookieCache?: boolean } }> = []
const viewCalls: unknown[][] = []
const mutateCalls: unknown[][] = []
let billingRoute: typeof import('../app/api/workspaces/[workspaceId]/billing/route')

before(async () => {
  mock.module('@/lib/auth', {
    namedExports: {
      auth: {
        api: {
          getSession: async (options: { headers: Headers; query?: { disableCookieCache?: boolean } }) => {
            sessionOptionsLog.push(options)
            if (!actor) return null
            return {
              user: { id: actor.id, name: 'Owner', email: 'owner@example.invalid' },
              session: { id: 'billing-unit-session' },
              ...(actor.tokenWorkspaceId ? { tokenWorkspaceId: actor.tokenWorkspaceId } : {}),
            }
          },
        },
      },
    },
  })
  mock.module('@/lib/billing/management', {
    namedExports: {
      billingManagementView: async (
        actorId: string,
        scope: unknown,
        selectedWorkspaceId?: string | null,
        principal?: unknown,
        usageMemberId?: string | null,
        requestedMonth?: string | null,
      ) => {
        const month = requestedMonth != null ? usageMonth.parse(requestedMonth) : currentMonth()
        viewCalls.push([actorId, scope, selectedWorkspaceId, principal, usageMemberId, requestedMonth])
        return { scope, usage: { month, costMicroUsd: 0, reservedMicroUsd: 0, unknownCalls: 0, externalUnknownRuns: 0, members: [] } }
      },
      mutateBillingManagement: async (...args: unknown[]) => {
        mutateCalls.push(args)
        return { ok: true }
      },
    },
  })
  billingRoute = await import('../app/api/workspaces/[workspaceId]/billing/route')
})

test('billingManagementPath and billingManagementRequest forward optional ?month=YYYY-MM', async t => {
  const scope = { kind: 'workspace' as const, id: WORKSPACE_A }
  assert.equal(billingManagementPath(scope), `/api/workspaces/${WORKSPACE_A}/billing`)
  assert.equal(
    billingManagementPath(scope, null, null, '2026-08'),
    `/api/workspaces/${WORKSPACE_A}/billing?month=2026-08`,
  )
  assert.equal(
    billingManagementPath(scope, WORKSPACE_B, 'member-1', '2026-08'),
    `/api/workspaces/${WORKSPACE_A}/billing?budgetWorkspace=${WORKSPACE_B}&usageMember=member-1&month=2026-08`,
  )

  const seenUrls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    seenUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return Response.json({ usage: { month: '2026-08' } })
  })
  const result = await billingManagementRequest<{ usage: { month: string } }>(scope, undefined, null, { month: '2026-08' })
  assert.deepEqual(result, { usage: { month: '2026-08' } })
  assert.equal(seenUrls.length, 1)
  assert.ok(seenUrls[0].endsWith(`/api/workspaces/${WORKSPACE_A}/billing?month=2026-08`), seenUrls[0])
})

test('GET /api/workspaces/[workspaceId]/billing forwards ?month=YYYY-MM and rejects invalid months with 400', async () => {
  actor = { id: 'owner-1' }
  viewCalls.length = 0
  sessionOptionsLog.length = 0
  const ctx = { params: Promise.resolve({ workspaceId: WORKSPACE_A }) }

  const pastRes = await billingRoute.GET(
    new Request(`https://mikka.test/api/workspaces/${WORKSPACE_A}/billing?month=2026-08`),
    ctx,
  )
  assert.equal(pastRes.status, 200)
  assert.equal(pastRes.headers.get('cache-control'), 'private, no-store')
  assert.equal(sessionOptionsLog.at(-1)?.query?.disableCookieCache, true)
  const pastBody = await pastRes.json() as { usage: { month: string } }
  assert.equal(pastBody.usage.month, '2026-08')
  assert.equal(viewCalls.at(-1)?.[5], '2026-08')

  const defaultRes = await billingRoute.GET(
    new Request(`https://mikka.test/api/workspaces/${WORKSPACE_A}/billing`),
    ctx,
  )
  assert.equal(defaultRes.status, 200)
  assert.equal(viewCalls.at(-1)?.[5], null)

  const beforeBad = viewCalls.length
  for (const bad of ['2026-13', '2026-00', 'bad', '']) {
    const res = await billingRoute.GET(
      new Request(`https://mikka.test/api/workspaces/${WORKSPACE_A}/billing?month=${encodeURIComponent(bad)}`),
      ctx,
    )
    assert.equal(res.status, 400, `month=${JSON.stringify(bad)}`)
    assert.deepEqual(await res.json(), { error: 'validationGeneric' })
  }
  assert.equal(viewCalls.length, beforeBad)
})

test('billing route enforces defineRoute auth, PAT workspace fencing, and POST origin checks', async () => {
  const ctx = { params: Promise.resolve({ workspaceId: WORKSPACE_A }) }
  viewCalls.length = 0
  mutateCalls.length = 0

  actor = null
  const unauth = await billingRoute.GET(
    new Request(`https://mikka.test/api/workspaces/${WORKSPACE_A}/billing?month=2026-08`),
    ctx,
  )
  assert.equal(unauth.status, 401)
  assert.deepEqual(await unauth.json(), { error: 'authRequired' })
  assert.equal(viewCalls.length, 0)

  actor = { id: 'owner-1', tokenWorkspaceId: WORKSPACE_B }
  const crossPat = await billingRoute.GET(
    new Request(`https://mikka.test/api/workspaces/${WORKSPACE_A}/billing?month=2026-08`),
    ctx,
  )
  assert.equal(crossPat.status, 403)
  assert.deepEqual(await crossPat.json(), { error: 'workspaceAccessDenied' })
  assert.equal(viewCalls.length, 0)

  actor = { id: 'owner-1' }
  const badOrigin = await billingRoute.POST(
    new Request(`https://mikka.test/api/workspaces/${WORKSPACE_A}/billing`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'portal', accountWorkspaceId: WORKSPACE_A }),
    }),
    ctx,
  )
  assert.equal(badOrigin.status, 403)
  assert.deepEqual(await badOrigin.json(), { error: 'originNotAllowed' })
  assert.equal(mutateCalls.length, 0)
})

test('Settings.sections.organization aligns nav and title consistently across en and zh-CN catalogs', () => {
  const en = JSON.parse(readFileSync('messages/en.json', 'utf8'))
  const zh = JSON.parse(readFileSync('messages/zh-CN.json', 'utf8'))
  assert.equal(en.Settings.sections.organization.nav, 'Organization')
  assert.equal(en.Settings.sections.organization.title, 'Organization')
  assert.equal(zh.Settings.sections.organization.nav, '组织')
  assert.equal(zh.Settings.sections.organization.title, '组织')
})
