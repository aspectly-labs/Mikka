// Regression tests for legacy P0 security & auth-boundary fixes (#226):
// - P0 #1: Workspace-scoped PAT rejection on account-global device & integration routes
// - P0 #2: Origin / Sec-Fetch-Site CSRF enforcement on 6 cookie-mutating routes
// - P0 #3: WorkspaceError -> 403/409 (never raw 500 or masked 503/409) across mobile,
//          cloud-computer, and thread routes + enterprisePrincipal forwarding in computer-policy
import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { enterprisePrincipal, type EnterprisePrincipal } from '../lib/enterprise/principal'
import { tokenWorkspace } from '../lib/tokens/principal'
import { WorkspaceError } from '../lib/workspace-error'

const ORIGIN = 'https://mikka.test'
const EVIL_ORIGIN = 'https://evil.example'
const WS_1 = '11111111-1111-4111-8111-111111111111'
const DEV_1 = '22222222-2222-4222-8222-222222222222'
const BOT_1 = '33333333-3333-4333-8333-333333333333'
const RUN_1 = '44444444-4444-4444-8444-444444444444'
const CONN_1 = '55555555-5555-4555-8555-555555555555'
const TASK_1 = '66666666-6666-4666-8666-666666666666'
const ISSUE_1 = '77777777-7777-4777-8777-777777777777'
const ART_1 = '88888888-8888-4888-8888-888888888888'

type TestUser = {
  id: string
  name: string
  email: string
  image: string | null
  [tokenWorkspace]?: string
  [enterprisePrincipal]?: EnterprisePrincipal
}
type TestSession = {
  user: TestUser
  session: { id: string }
  tokenId?: string
  tokenWorkspaceId?: string
}

let apiSession: TestSession | null = null
let browserSession: { user: TestUser; session: { id: string } } | null = null
let workspaceError: WorkspaceError | null = null
let requireWorkspaceCalls: Array<{ workspaceId: string; userId: string; admin: boolean; principal: unknown }> = []
let dispatchRecoveryCalls = 0
let disconnectGitHubCalls = 0
let mintEnrollmentCalls = 0
let enqueueCommandCalls = 0
let setModelsCalls = 0
let refreshModelsCalls = 0
let createIntentCalls = 0
let confirmIntentCalls = 0

function makeBrowserSession(): TestSession {
  return {
    user: {
      id: 'user-1',
      name: 'Alex',
      email: 'alex@example.com',
      image: null,
      [enterprisePrincipal]: { kind: 'session', sessionId: 'sess-1' },
    },
    session: { id: 'sess-1' },
  }
}

function makePatSession(): TestSession {
  return {
    user: {
      id: 'user-1',
      name: 'Alex',
      email: 'alex@example.com',
      image: null,
      [tokenWorkspace]: WS_1,
      [enterprisePrincipal]: { kind: 'pat', tokenId: 'pat-1', workspaceId: WS_1 },
    },
    session: { id: 'pat:pat-1' },
    tokenId: 'pat-1',
    tokenWorkspaceId: WS_1,
  }
}

before(async () => {
  mock.module('@/lib/fresh-session', {
    namedExports: { freshSessionRoute: (handler: unknown) => handler, withFreshSession: (fn: () => unknown) => fn() },
  })
  mock.module('@/lib/request-log', {
    namedExports: { withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {}, noteLogRpcAction: () => {} },
  })
  mock.module('@/lib/api-auth', {
    namedExports: {
      auth: { api: { getSession: async () => apiSession } },
      apiWorkspaceAllowed: (session: TestSession, wsId: string) =>
        !session.tokenWorkspaceId || session.tokenWorkspaceId === wsId,
    },
  })
  mock.module('@/lib/auth', {
    namedExports: {
      auth: { api: { getSession: async () => browserSession } },
      authBaseURL: ORIGIN,
      MOBILE_APP_ORIGIN: 'mikka://',
    },
  })
  mock.module('@/lib/mobile-api', {
    namedExports: {
      NO_STORE: { 'Cache-Control': 'private, no-store' },
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      mobileUser: async () => apiSession?.user ?? null,
      writeAllowed: () => true,
      unauthorized: () => new Response(JSON.stringify({ error: 'authRequired' }), { status: 401 }),
      forbiddenOrigin: () => new Response(JSON.stringify({ error: 'originNotAllowed' }), { status: 403 }),
    },
  })
  mock.module('@/lib/db', {
    namedExports: {
      pool: { query: async () => ({ rows: [], rowCount: 0 }) },
      db: { select: () => ({ from: () => ({ where: () => ({ groupBy: async () => [], limit: async () => [] }) }) }) },
      withDatabaseClient: async (fn: (client: unknown) => Promise<unknown>) =>
        fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
      withDatabaseTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      createRequestDatabaseScope: () => ({}),
      readUnderDeviceAuthority: async (fn: () => Promise<unknown>) => fn(),
    },
  })
  mock.module('@/lib/workspace-db', {
    namedExports: {
      workspaceDb: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
      workspacePool: { query: async () => ({ rows: [], rowCount: 0 }) },
    },
  })
  mock.module('@/lib/workspace-access', {
    namedExports: {
      WorkspaceError,
      loadWorkspaceContext: async () => {
        if (workspaceError) throw workspaceError
        return { workspace: { id: WS_1, name: 'Personal', kind: 'personal' }, role: 'admin', choices: [] }
      },
      loadWorkspaceSettings: async () => {
        if (workspaceError) throw workspaceError
        return { workspace: { id: WS_1, name: 'Personal', kind: 'personal' }, role: 'admin', choices: [] }
      },
      requireWorkspace: async (_tx: unknown, workspaceId: string, userId: string, admin: boolean, principal: unknown) => {
        requireWorkspaceCalls.push({ workspaceId, userId, admin, principal })
        return { membership: { role: 'admin' } }
      },
    },
  })
  mock.module('@/lib/device-enrollment', {
    namedExports: {
      mintDeviceEnrollment: async () => {
        mintEnrollmentCalls++
        return 'enroll-token'
      },
    },
  })
  mock.module('@/lib/devices/dispatchable', {
    namedExports: { listDispatchableDevices: async () => [{ id: DEV_1 }] },
  })
  mock.module('@/lib/device-management', {
    namedExports: {
      enqueueDeviceCommand: async () => {
        enqueueCommandCalls++
        return 'cmd-1'
      },
    },
  })
  mock.module('@/lib/composio', {
    namedExports: {
      getComposio: () => null,
      runComposioAction: async () => ({ ok: false }),
      resolveActionAccount: async () => null,
      readComposioAccountEmail: async () => null,
      renameComposioAccount: async () => {},
      retireComposioAccount: async () => {},
    },
  })
  mock.module('@/lib/composio-config', { namedExports: { isComposioCallbackVerifierConfigured: () => false } })
  mock.module('@/lib/github/connection', {
    namedExports: {
      GITHUB_CONNECT_COOKIE: 'mikka-github-connect',
      GITHUB_CALLBACK_PATH: '/api/auth/callback/github',
      disconnectGitHub: async () => { disconnectGitHubCalls++ },
      githubConnectConfigured: async () => true,
      githubConnection: async () => null,
      githubConnectionToken: async () => null,
      saveSealedGitHubConnection: async () => {},
      saveGitHubConnection: async () => {},
      startGitHubConnect: async () => ({}),
      githubAuthorizeURL: async () => '',
      githubConnectUser: () => null,
      exchangeGitHubCode: async () => ({}),
      completeGitHubConnect: async () => ({}),
      sealGitHubSecret: (v: string) => v,
      unsealGitHubSecret: (v: string) => v,
    },
  })
  mock.module('@/lib/github/connect-intent', {
    namedExports: {
      createConnectIntent: async () => { createIntentCalls++; return { token: 'ghi_1' } },
      loopbackStart: () => null,
      readConnectIntent: async () => ({ status: 'pending' }),
      confirmLoopbackIntent: async () => { confirmIntentCalls++; return { connected: true } },
    },
  })
  mock.module('@/lib/connection-models', {
    namedExports: {
      connectionModels: async () => [],
      setConnectionModels: async () => { setModelsCalls++; return [] },
      refreshConnectionModels: async () => { refreshModelsCalls++; return [] },
    },
  })
  mock.module('@/lib/factory/runtime', {
    namedExports: {
      factoryLifecycleEnabled: () => true,
      factoryAuthorize: () => ({}),
      factoryRuntimeForBot: () => ({}),
      guardFactoryClaim: async () => {},
    },
  })
  mock.module('@/lib/factory/workspace-http', {
    namedExports: { factoryHumanWorkspaceResponse: async (_user: unknown, fn: () => Promise<Response>) => fn() },
  })
  mock.module('@/lib/factory/dispatch-recovery-server', { namedExports: { factoryDispatchRecovery: {} } })
  mock.module('@/lib/factory/dispatch-recovery-http', {
    namedExports: {
      handleFactoryDispatchRecovery: async () => {
        dispatchRecoveryCalls++
        return { status: 200, body: { ok: true }, headers: {} }
      },
    },
  })
  mock.module('@/lib/cloud-computer-flag', {
    namedExports: {
      cloudComputerRunsEnabled: () => true,
      cloudComputerTasksEnabled: () => true,
      byosEnabled: () => true,
      byosEnrollmentEnabled: () => true,
    },
  })
  mock.module('@/lib/issue-access', {
    namedExports: {
      requireUser: async () => apiSession?.user ?? null,
      requireIssueAccess: async () => ({ issue: { id: ISSUE_1, userId: 'user-1', title: 'Task', content: null } }),
      requireIssueAccessWithoutBody: async () => ({ issue: { id: ISSUE_1, userId: 'user-1', title: 'Task' } }),
      issueForUser: async () => ({ id: ISSUE_1, userId: 'user-1', title: 'Task', content: null }),
      issueAccessForUser: async () => ({ issue: { id: ISSUE_1, userId: 'user-1', title: 'Task', content: null } }),
    },
  })
  mock.module('@/lib/tokens/scope', { namedExports: { artifactOutsideToken: async () => false } })
  mock.module('@/lib/artifacts/delete', { namedExports: { deleteOwnArtifact: async () => true } })
  mock.module('@/lib/computer/store', {
    namedExports: {
      ComputerError: class ComputerError extends Error {
        constructor(readonly status: number, message: string) { super(message) }
      },
      ComputerStore: class ComputerStore {
        async getPolicy() { return { permission: 'allow' } }
      },
    },
  })
  mock.module('@/lib/computer/policy-route', {
    namedExports: {
      createComputerPolicyHandler: (deps: {
        withMember: (req: Request, wsId: string, admin: boolean, op: (isAdmin: boolean) => Promise<Response>) => Promise<Response | null>
      }) => async (req: Request, wsId: string) => {
        const res = await deps.withMember(req, wsId, req.method === 'POST', async () => Response.json({ ok: true }))
        return res ?? Response.json({ error: 'denied' }, { status: 403 })
      },
    },
  })
})

beforeEach(() => {
  apiSession = makeBrowserSession()
  browserSession = makeBrowserSession()
  workspaceError = null
  requireWorkspaceCalls = []
  dispatchRecoveryCalls = 0
  disconnectGitHubCalls = 0
  mintEnrollmentCalls = 0
  enqueueCommandCalls = 0
  setModelsCalls = 0
  refreshModelsCalls = 0
  createIntentCalls = 0
  confirmIntentCalls = 0
})

test('P0 #1: workspace-scoped PATs are refused on account-global device and integration routes', async () => {
  const enrollment = await import('../app/api/devices/enrollment/route')
  const devices = await import('../app/api/devices/route')
  const commands = await import('../app/api/devices/[deviceId]/commands/route')
  const composio = await import('../app/api/integrations/composio/route')
  const github = await import('../app/api/integrations/github/route')

  apiSession = makePatSession()

  // 1. devices/enrollment POST & GET refuse PAT Authorization header even when Origin matches and a cookie session exists.
  const patEnrollPost = await enrollment.POST(new Request(`${ORIGIN}/api/devices/enrollment`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer mkp_${'a'.repeat(43)}`, cookie: 'session=valid' },
  }))
  assert.equal(patEnrollPost.status, 403)
  assert.equal(mintEnrollmentCalls, 0)

  const patEnrollGet = await enrollment.GET(new Request(`${ORIGIN}/api/devices/enrollment`, {
    headers: { authorization: `Bearer mkp_${'a'.repeat(43)}` },
  }))
  assert.equal(patEnrollGet.status, 403)

  // Normal browser session still succeeds on POST /api/devices/enrollment.
  apiSession = makeBrowserSession()
  const browserEnrollPost = await enrollment.POST(new Request(`${ORIGIN}/api/devices/enrollment`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: 'session=valid', 'sec-fetch-site': 'same-origin' },
  }))
  assert.equal(browserEnrollPost.status, 200)
  assert.equal(mintEnrollmentCalls, 1)
  apiSession = makePatSession()

  // 2. GET /api/devices refuses PAT session.
  assert.equal((await devices.GET(new Request(`${ORIGIN}/api/devices`))).status, 403)

  // 3. GET & POST /api/devices/:deviceId/commands refuse PAT session even with matching Origin.
  const cmdParams = { params: Promise.resolve({ deviceId: DEV_1 }) }
  assert.equal((await commands.GET(new Request(`${ORIGIN}/api/devices/${DEV_1}/commands`), cmdParams)).status, 403)
  assert.equal((await commands.POST(new Request(`${ORIGIN}/api/devices/${DEV_1}/commands`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'restart' }),
  }), cmdParams)).status, 403)
  assert.equal(enqueueCommandCalls, 0)

  // 4. GET/POST/DELETE/PATCH /api/integrations/composio refuse PAT session.
  assert.equal((await composio.GET(new Request(`${ORIGIN}/api/integrations/composio`))).status, 403)
  for (const method of ['POST', 'DELETE', 'PATCH'] as const) {
    const res = await composio[method](new Request(`${ORIGIN}/api/integrations/composio`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1' }),
    }))
    assert.equal(res.status, 403, `composio ${method} must reject PAT`)
  }

  // 5. GET & DELETE /api/integrations/github and GET /api/integrations/github/connect/intent refuse PAT.
  assert.equal((await github.GET(new Request(`${ORIGIN}/api/integrations/github`))).status, 403)
  assert.equal((await github.DELETE(new Request(`${ORIGIN}/api/integrations/github`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, authorization: `Bearer mkp_${'a'.repeat(43)}` },
  }))).status, 403)
  assert.equal(disconnectGitHubCalls, 0)
  const githubIntent = await import('../app/api/integrations/github/connect/intent/route')
  assert.equal((await githubIntent.GET(new Request(`${ORIGIN}/api/integrations/github/connect/intent?token=t`, {
    headers: { authorization: `Bearer mkp_${'a'.repeat(43)}`, cookie: 'session=valid' },
  }))).status, 403)
})

test('P0 #2: 6 cookie-mutating routes reject cross-site/missing-Origin CSRF and accept valid callers', async () => {
  const models = await import('../app/api/connections/[id]/models/route')
  const refresh = await import('../app/api/connections/[id]/models/refresh/route')
  const github = await import('../app/api/integrations/github/route')
  const intent = await import('../app/api/integrations/github/connect/intent/route')
  const confirm = await import('../app/api/integrations/github/connect/intent/confirm/route')
  const cloudDispatch = await import('../app/api/factory/tasks/[taskId]/dispatch/cloud/route')

  const connParams = { params: Promise.resolve({ id: CONN_1 }) }
  const taskParams = { params: Promise.resolve({ taskId: TASK_1 }) }

  const badBrowserHeaders: Record<string, string>[] = [
    { cookie: 'session=valid' },
    { cookie: 'session=valid', origin: EVIL_ORIGIN },
    { cookie: 'session=valid', origin: 'null' },
    { cookie: 'session=valid', origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
    { cookie: 'session=valid', origin: ORIGIN, 'sec-fetch-site': 'same-site' },
  ]

  for (const hdrs of badBrowserHeaders) {
    assert.equal((await models.PATCH(new Request(`${ORIGIN}/api/connections/${CONN_1}/models`, {
      method: 'PATCH', headers: { ...hdrs, 'content-type': 'application/json' }, body: JSON.stringify({ models: { 'm-1': true } }),
    }), connParams)).status, 403)

    assert.equal((await refresh.POST(new Request(`${ORIGIN}/api/connections/${CONN_1}/models/refresh`, {
      method: 'POST', headers: hdrs,
    }), connParams)).status, 403)

    assert.equal((await github.DELETE(new Request(`${ORIGIN}/api/integrations/github`, {
      method: 'DELETE', headers: hdrs,
    }))).status, 403)

    assert.equal((await intent.POST(new Request(`${ORIGIN}/api/integrations/github/connect/intent`, {
      method: 'POST', headers: hdrs, body: '{}',
    }))).status, 403)

    assert.equal((await confirm.POST(new Request(`${ORIGIN}/api/integrations/github/connect/intent/confirm`, {
      method: 'POST', headers: hdrs, body: JSON.stringify({ token: 't', verifier: 'v' }),
    }))).status, 403)

    assert.equal((await cloudDispatch.POST(new Request(`${ORIGIN}/api/factory/tasks/${TASK_1}/dispatch/cloud`, {
      method: 'POST', headers: hdrs,
    }), taskParams)).status, 403)
  }

  assert.equal(setModelsCalls, 0)
  assert.equal(refreshModelsCalls, 0)
  assert.equal(disconnectGitHubCalls, 0)
  assert.equal(createIntentCalls, 0)
  assert.equal(confirmIntentCalls, 0)
  assert.equal(dispatchRecoveryCalls, 0)

  // Valid same-origin cookie requests succeed on all 6 routes.
  const okHeaders = { cookie: 'session=valid', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  assert.equal((await models.PATCH(new Request(`${ORIGIN}/api/connections/${CONN_1}/models`, {
    method: 'PATCH', headers: okHeaders, body: JSON.stringify({ models: { 'm-1': true } }),
  }), connParams)).status, 200)
  assert.equal((await refresh.POST(new Request(`${ORIGIN}/api/connections/${CONN_1}/models/refresh`, {
    method: 'POST', headers: okHeaders,
  }), connParams)).status, 200)
  assert.equal((await github.DELETE(new Request(`${ORIGIN}/api/integrations/github`, {
    method: 'DELETE', headers: okHeaders,
  }))).status, 200)
  assert.equal((await intent.POST(new Request(`${ORIGIN}/api/integrations/github/connect/intent`, {
    method: 'POST', headers: okHeaders, body: '{}',
  }))).status, 200)
  assert.equal((await confirm.POST(new Request(`${ORIGIN}/api/integrations/github/connect/intent/confirm`, {
    method: 'POST', headers: okHeaders, body: JSON.stringify({ token: 't', verifier: 'v' }),
  }))).status, 200)
  assert.equal((await cloudDispatch.POST(new Request(`${ORIGIN}/api/factory/tasks/${TASK_1}/dispatch/cloud`, {
    method: 'POST', headers: okHeaders,
  }), taskParams)).status, 200)

  // Native cookie-less Desktop confirm (no Origin, no Cookie) still works, while foreign Origin is rejected.
  assert.equal((await confirm.POST(new Request(`${ORIGIN}/api/integrations/github/connect/intent/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 't', verifier: 'v' }),
  }))).status, 200)
  assert.equal((await confirm.POST(new Request(`${ORIGIN}/api/integrations/github/connect/intent/confirm`, {
    method: 'POST', headers: { origin: EVIL_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ token: 't', verifier: 'v' }),
  }))).status, 403)

  // Workspace-scoped PAT without Origin still works on connection models, while foreign Origin is rejected.
  apiSession = makePatSession()
  assert.equal((await models.PATCH(new Request(`${ORIGIN}/api/connections/${CONN_1}/models`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: { 'm-1': false } }),
  }), connParams)).status, 200)
  assert.equal((await models.PATCH(new Request(`${ORIGIN}/api/connections/${CONN_1}/models`, {
    method: 'PATCH', headers: { origin: EVIL_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ models: { 'm-1': false } }),
  }), connParams)).status, 403)
})

test('P0 #3: WorkspaceError returns 403/409 across all 10 routes and computer-policy forwards enterprisePrincipal', async () => {
  const mobileHome = await import('../app/api/mobile/home/route')
  const mobileSettings = await import('../app/api/mobile/settings/route')
  const mobileBots = await import('../app/api/mobile/bots/route')
  const mobileArtifacts = await import('../app/api/mobile/artifacts/[id]/route')
  const computerRuns = await import('../app/api/bots/[botId]/computer/runs/route')
  const computerRuntimes = await import('../app/api/bots/[botId]/computer/runtimes/route')
  const computerSub = await import('../app/api/bots/[botId]/computer/subscription/route')
  const threadMachine = await import('../app/api/threads/[runId]/machine/route')
  const threadBrowser = await import('../app/api/threads/[runId]/browser/route')
  const threadUploads = await import('../app/api/threads/[runId]/uploads/route')
  const computerPolicy = await import('../app/api/workspaces/[workspaceId]/computer-policy/route')

  workspaceError = new WorkspaceError('workspaceAccessDenied')

  const checks: Array<[string, Promise<Response>]> = [
    ['GET /api/mobile/home', mobileHome.GET(new Request(`${ORIGIN}/api/mobile/home`))],
    ['GET /api/mobile/settings', mobileSettings.GET(new Request(`${ORIGIN}/api/mobile/settings`))],
    ['POST /api/mobile/bots', mobileBots.POST(new Request(`${ORIGIN}/api/mobile/bots`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bot' }),
    }))],
    ['DELETE /api/mobile/artifacts/[id]', mobileArtifacts.DELETE(
      new Request(`${ORIGIN}/api/mobile/artifacts/${ART_1}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: ART_1 }) },
    )],
    ['POST /api/bots/[botId]/computer/runs', computerRuns.POST(
      new Request(`${ORIGIN}/api/bots/${BOT_1}/computer/runs`, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ issueId: ISSUE_1 }),
      }),
      { params: Promise.resolve({ botId: BOT_1 }) },
    )],
    ['GET /api/bots/[botId]/computer/runtimes', computerRuntimes.GET(
      new Request(`${ORIGIN}/api/bots/${BOT_1}/computer/runtimes`),
      { params: Promise.resolve({ botId: BOT_1 }) },
    )],
    ['POST /api/bots/[botId]/computer/subscription', computerSub.POST(
      new Request(`${ORIGIN}/api/bots/${BOT_1}/computer/subscription`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONN_1, revision: 1, harness: 'codex', modelId: 'gpt-6-luna' }),
      }),
      { params: Promise.resolve({ botId: BOT_1 }) },
    )],
    ['GET /api/threads/[runId]/machine', threadMachine.GET(
      new Request(`${ORIGIN}/api/threads/${RUN_1}/machine`),
      { params: Promise.resolve({ runId: RUN_1 }) },
    )],
    ['POST /api/threads/[runId]/machine', threadMachine.POST(
      new Request(`${ORIGIN}/api/threads/${RUN_1}/machine`, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }),
      }),
      { params: Promise.resolve({ runId: RUN_1 }) },
    )],
    ['POST /api/threads/[runId]/browser', threadBrowser.POST(
      new Request(`${ORIGIN}/api/threads/${RUN_1}/browser`, { method: 'POST', headers: { origin: ORIGIN } }),
      { params: Promise.resolve({ runId: RUN_1 }) },
    )],
    ['GET /api/threads/[runId]/uploads', threadUploads.GET(
      new Request(`${ORIGIN}/api/threads/${RUN_1}/uploads`),
      { params: Promise.resolve({ runId: RUN_1 }) },
    )],
  ]

  for (const [label, pending] of checks) {
    const res = await pending
    assert.equal(res.status, 403, `${label} must return 403 on workspaceAccessDenied`)
    assert.deepEqual(await res.json(), { error: 'workspaceAccessDenied' }, `${label} error body`)
  }

  // Non-denial WorkspaceError maps to 409.
  workspaceError = new WorkspaceError('workspacePersonal')
  const conflict = await mobileHome.GET(new Request(`${ORIGIN}/api/mobile/home`))
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), { error: 'workspacePersonal' })

  // computer-policy forwards session.user[enterprisePrincipal] to requireWorkspace for PAT and browser sessions.
  workspaceError = null
  apiSession = makePatSession()
  const policyRes = await computerPolicy.GET(
    new Request(`${ORIGIN}/api/workspaces/${WS_1}/computer-policy`),
    { params: Promise.resolve({ workspaceId: WS_1 }) },
  )
  assert.equal(policyRes.status, 200)
  assert.equal(requireWorkspaceCalls.length, 1)
  assert.deepEqual(requireWorkspaceCalls[0].principal, { kind: 'pat', tokenId: 'pat-1', workspaceId: WS_1 })
})
