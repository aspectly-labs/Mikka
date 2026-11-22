import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, mock, test } from 'node:test'
import { DEFAULT_REVIEW_RULE } from '@mikka/protocol/orchestrator'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Review rule settings require an isolated loopback *_e2e database')
const dbTest = available ? test : test.skip

const owner = `review-rule-admin-${randomUUID()}`
const member = `review-rule-member-${randomUUID()}`
const suspended = `review-rule-suspended-${randomUUID()}`
const outsider = `review-rule-outsider-${randomUUID()}`
const workspaceId = randomUUID()
const otherWorkspaceId = randomUUID()
const homes: string[] = []

let currentUser: { id: string; email: string; name: string } | null = null
let pool: (typeof import('@/lib/db'))['pool']
let workspacePool: (typeof import('@/lib/workspace-db'))['workspacePool']
let personal: typeof import('@/app/api/settings/personal/route')
let workspace: typeof import('@/app/api/settings/workspace/[workspaceId]/route')
let personalReset: typeof import('@/app/api/settings/personal/reset/route')
let workspaceReset: typeof import('@/app/api/settings/workspace/[workspaceId]/reset/route')
let schemaRoute: typeof import('@/app/api/settings/schema/route')
let reviewRulesRoute: typeof import('@/app/api/settings/workspace/[workspaceId]/review-rules/route')
let desktopActions: (typeof import('@/lib/desktop-rpc/registry'))['desktopActions']
let dispatchRpc: (typeof import('@/lib/desktop-rpc/handler'))['dispatchRpc']
let wire: typeof import('@/lib/desktop-rpc/wire')

const as = (id: string | null) => {
  currentUser = id ? { id, email: `${id}@example.invalid`, name: id } : null
}
const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://127.0.0.1/api/settings/${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
const context = (id = workspaceId) => ({ params: Promise.resolve({ workspaceId: id }) })
const patch = (values: Record<string, unknown>) => ({ values })

async function invokeRpc(action: string, args: unknown[]) {
  const req = new Request('http://127.0.0.1/api/desktop-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: wire.DESKTOP_RPC_VERSION, action, args: wire.encode(args) }),
  })
  const res = await dispatchRpc({ actions: desktopActions, scope: async (_s, work) => work() }, req, currentUser)
  const payload = await res.json()
  return { status: res.status, ok: payload.ok as boolean, result: payload.ok ? wire.decode(payload.result) : payload.error }
}

before(async () => {
  if (!available) return
  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/intl/i18n-server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  mock.module('@/lib/session', { namedExports: { getSession: async () => currentUser ? { user: currentUser, session: { id: 'review-rules-test-session' } } : null } })
  mock.module('@/lib/suggestions/sources', { namedExports: { connectedComposioApps: async () => [] } })
  ;({ pool } = await import('@/lib/db'))
  ;({ workspacePool } = await import('@/lib/workspace-db'))
  personal = await import('@/app/api/settings/personal/route')
  workspace = await import('@/app/api/settings/workspace/[workspaceId]/route')
  personalReset = await import('@/app/api/settings/personal/reset/route')
  workspaceReset = await import('@/app/api/settings/workspace/[workspaceId]/reset/route')
  schemaRoute = await import('@/app/api/settings/schema/route')
  reviewRulesRoute = await import('@/app/api/settings/workspace/[workspaceId]/review-rules/route')
  ;({ desktopActions } = await import('@/lib/desktop-rpc/registry'))
  ;({ dispatchRpc } = await import('@/lib/desktop-rpc/handler'))
  wire = await import('@/lib/desktop-rpc/wire')

  const migration = await readFile(new URL('../../drizzle/20261122004735_workspace_review_rules.sql', import.meta.url), 'utf8')
  await pool.query(migration)

  for (const id of [owner, member, suspended, outsider]) {
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
    const home = randomUUID()
    homes.push(home)
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Personal\',\'personal\')', [home, id])
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [home, id, `${id}@example.invalid`])
  }
  for (const [id, person] of [[workspaceId, owner], [otherWorkspaceId, outsider]] as const) {
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Review rules team\',\'team\')', [id, person])
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [id, person, `${person}@example.invalid`])
  }
  await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')', [workspaceId, member, `${member}@example.invalid`])
  await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'suspended\')', [workspaceId, suspended, `${suspended}@example.invalid`])
})

after(async () => {
  if (!available) return
  const workspaceIds = [workspaceId, otherWorkspaceId, ...homes]
  const users = [owner, member, suspended, outsider]
  await pool.query('DELETE FROM workspace_review_rules WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM personal_setting_values WHERE "userId"=ANY($1)', [users])
  await pool.query('DELETE FROM workspace_setting_values WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [users])
  await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [users])
  await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [users])
  await pool.query('DELETE FROM agent_kit_heads WHERE owner_id=ANY($1)', [users])
  await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
  await (await import('@/lib/builtin-gateway/runtime')).builtinGateway()?.stop()
  await Promise.all([pool.end(), workspacePool.end()])
})

dbTest('review-rules REST and Desktop RPC reject unauthenticated, cross-workspace, suspended and non-admin callers', async () => {
  const path = `workspace/${workspaceId}/review-rules`
  const validRule = {
    requirePullRequest: true,
    requireCi: true,
    checkHarness: 'codex' as const,
    branchTemplate: 'mikka/{team}-{number}',
    prBodyTemplate: null,
  }

  // 1. Unauthenticated -> 401 authRequired
  as(null)
  for (const res of [
    await reviewRulesRoute.GET(request(path), context()),
    await reviewRulesRoute.PATCH(request(path, 'PATCH', { rule: validRule }), context()),
    await reviewRulesRoute.DELETE(request(path, 'DELETE', {}), context()),
  ]) {
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'authRequired')
  }
  for (const rpc of [
    await invokeRpc('review-rule-settings.getWorkspaceReviewRules', [workspaceId]),
    await invokeRpc('review-rule-settings.saveWorkspaceReviewRule', [workspaceId, { rule: validRule }]),
    await invokeRpc('review-rule-settings.deleteWorkspaceReviewRule', [workspaceId, {}]),
  ]) {
    assert.equal(rpc.ok, true)
    assert.deepEqual(rpc.result, { error: 'authRequired', params: undefined })
  }

  // 2. Cross-workspace / non-member & suspended admin -> 403 workspaceAccessDenied
  for (const deniedUser of [outsider, suspended]) {
    as(deniedUser)
    for (const res of [
      await reviewRulesRoute.GET(request(path), context()),
      await reviewRulesRoute.PATCH(request(path, 'PATCH', { rule: validRule }), context()),
      await reviewRulesRoute.DELETE(request(path, 'DELETE', {}), context()),
    ]) {
      assert.equal(res.status, 403)
      assert.equal((await res.json()).error, 'workspaceAccessDenied')
    }
    for (const rpc of [
      await invokeRpc('review-rule-settings.getWorkspaceReviewRules', [workspaceId]),
      await invokeRpc('review-rule-settings.saveWorkspaceReviewRule', [workspaceId, { rule: validRule }]),
      await invokeRpc('review-rule-settings.deleteWorkspaceReviewRule', [workspaceId, {}]),
    ]) {
      assert.equal(rpc.ok, true)
      assert.deepEqual(rpc.result, { error: 'workspaceAccessDenied' })
    }
  }

  // 3. Ordinary member can GET (200), but cannot PATCH or DELETE (403)
  as(member)
  const memberGet = await reviewRulesRoute.GET(request(path), context())
  assert.equal(memberGet.status, 200)
  assert.deepEqual(await memberGet.json(), {
    workspaceId,
    rule: { value: DEFAULT_REVIEW_RULE, source: 'default', updatedAt: null },
    overrides: [],
  })
  const memberRpcGet = await invokeRpc('review-rule-settings.getWorkspaceReviewRules', [workspaceId])
  assert.equal(memberRpcGet.ok, true)
  assert.deepEqual(memberRpcGet.result, {
    workspaceId,
    rule: { value: DEFAULT_REVIEW_RULE, source: 'default', updatedAt: null },
    overrides: [],
  })

  for (const res of [
    await reviewRulesRoute.PATCH(request(path, 'PATCH', { rule: validRule }), context()),
    await reviewRulesRoute.PATCH(request(path, 'PATCH', { repoKey: 'github.com/acme/app', rule: validRule }), context()),
    await reviewRulesRoute.DELETE(request(path, 'DELETE', {}), context()),
  ]) {
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'workspaceAccessDenied')
  }
  for (const rpc of [
    await invokeRpc('review-rule-settings.saveWorkspaceReviewRule', [workspaceId, { rule: validRule }]),
    await invokeRpc('review-rule-settings.deleteWorkspaceReviewRule', [workspaceId, {}]),
  ]) {
    assert.equal(rpc.ok, true)
    assert.deepEqual(rpc.result, { error: 'workspaceAccessDenied' })
  }
})

dbTest('workspace admin CRUDs workspace default reviewRule and per-repository overrides with source metadata and replay safety', async () => {
  const path = `workspace/${workspaceId}/review-rules`
  const { resolveEffectiveReviewRule } = await import('./contract')
  as(owner)

  // Save workspace-level rule via REST PATCH
  const savedWs = await reviewRulesRoute.PATCH(request(path, 'PATCH', {
    rule: {
      requirePullRequest: true,
      requireCi: false,
      checkHarness: 'claude_code',
      branchTemplate: 'team/{team}-{number}',
      prBodyTemplate: 'Summary for {key}: {summary}',
    },
  }), context())
  assert.equal(savedWs.status, 200)
  const wsBody = await savedWs.json()
  assert.equal(wsBody.rule.source, 'workspace')
  assert.ok(typeof wsBody.rule.updatedAt === 'string')
  assert.deepEqual(wsBody.rule.value, {
    requirePullRequest: true,
    requireCi: false,
    checkHarness: 'claude_code',
    branchTemplate: 'team/{team}-{number}',
    prBodyTemplate: 'Summary for {key}: {summary}',
  })

  // Add per-repository override ("+" roster entry) via Desktop RPC with clone URL normalization
  const rpcOverride = await invokeRpc('review-rule-settings.saveWorkspaceReviewRule', [
    workspaceId,
    {
      repoKey: 'https://github.com/Acme/Core-Service.git',
      rule: {
        requirePullRequest: true,
        requireCi: true,
        checkHarness: 'codex',
        branchTemplate: 'core/{number}',
        prBodyTemplate: null,
      },
    },
  ])
  assert.equal(rpcOverride.ok, true)
  const viewWithOverride = rpcOverride.result as import('./contract').WorkspaceReviewRulesView
  assert.equal(viewWithOverride.overrides.length, 1)
  assert.equal(viewWithOverride.overrides[0]!.repoKey, 'github.com/acme/core-service')
  assert.equal(viewWithOverride.overrides[0]!.source, 'repository')
  assert.equal(viewWithOverride.overrides[0]!.rule.checkHarness, 'codex')

  assert.deepEqual(resolveEffectiveReviewRule(viewWithOverride, 'git@github.com:Acme/Core-Service.git'), {
    value: viewWithOverride.overrides[0]!.rule,
    source: 'repository',
  })
  assert.deepEqual(resolveEffectiveReviewRule(viewWithOverride, 'github.com/acme/other'), {
    value: viewWithOverride.rule.value,
    source: 'workspace',
  })

  // Reject invalid inputs (400) without mutating stored rows
  for (const invalidBody of [
    { rule: { branchTemplate: 'no-number-placeholder' } },
    { rule: { branchTemplate: 'mikka/bad..ref-{number}' } },
    { rule: { checkHarness: 'gemini' } },
    { rule: { requirePullRequest: true, extra: 1 } },
    { repoKey: '/local/filesystem/path', rule: DEFAULT_REVIEW_RULE },
    { repoKey: 'github.com/../escape', rule: DEFAULT_REVIEW_RULE },
    { rule: DEFAULT_REVIEW_RULE, ownerId: outsider },
  ]) {
    const rejected = await reviewRulesRoute.PATCH(request(path, 'PATCH', invalidBody), context())
    assert.equal(rejected.status, 400)
  }

  // Malformed JSON and invalid DELETE payloads fail with 400 without mutating stored rows
  const malformedDelete = await reviewRulesRoute.DELETE(
    new Request(`http://127.0.0.1/api/settings/${path}`, {
      method: 'DELETE',
      body: '{invalid-json',
      headers: { 'Content-Type': 'application/json' },
    }),
    context(),
  )
  assert.equal(malformedDelete.status, 400)
  assert.equal((await reviewRulesRoute.DELETE(request(path, 'DELETE', { unknown: true }), context())).status, 400)

  // Replaying additive SQL migration twice preserves all saved rules
  const migration = await readFile(new URL('../../drizzle/20261122004735_workspace_review_rules.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  await pool.query(migration)

  const afterReplay = await (await reviewRulesRoute.GET(request(path), context())).json()
  assert.equal(afterReplay.rule.source, 'workspace')
  assert.equal(afterReplay.overrides.length, 1)

  // Delete repository override only -> workspace rule remains
  const deletedOverride = await reviewRulesRoute.DELETE(request(path, 'DELETE', { repoKey: 'github.com/acme/core-service' }), context())
  assert.equal(deletedOverride.status, 200)
  const afterOverrideDelete = await deletedOverride.json()
  assert.equal(afterOverrideDelete.overrides.length, 0)
  assert.equal(afterOverrideDelete.rule.source, 'workspace')

  // Delete workspace rule -> resets to source: 'default'
  const resetWs = await invokeRpc('review-rule-settings.deleteWorkspaceReviewRule', [workspaceId, {}])
  assert.equal(resetWs.ok, true)
  const afterReset = resetWs.result as import('./contract').WorkspaceReviewRulesView
  assert.equal(afterReset.rule.source, 'default')
  assert.equal(afterReset.rule.updatedAt, null)
  assert.deepEqual(afterReset.rule.value, DEFAULT_REVIEW_RULE)
})

dbTest('gitAuthorName and gitAuthorEmail persist, inherit, enforce write auth, and flow through readCliRunPolicy', async () => {
  const agentId = randomUUID()
  const deviceId = randomUUID()
  const runId = randomUUID()
  await pool.query('INSERT INTO devices (id,"ownerId",name,platform,arch,"daemonVersion",enabled,kind) VALUES ($1,$2,\'Test device\',\'darwin\',\'arm64\',\'0.0.1\',true,\'local\')', [deviceId, member])
  await pool.query('INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,\'Worker\',\'codex\',$3)', [agentId, member, deviceId])
  await pool.query('INSERT INTO agent_runs (id,"userId","workspaceId","agentId","deviceId",status,kind,prompt) VALUES ($1,$2,$3,$4,$5,\'running\',\'implement\',\'Test\')', [runId, member, workspaceId, agentId, deviceId])

  const { readCliRunPolicy } = await import('@/lib/agent-tool-approval/policy-store')

  // Default: neither personal nor workspace set -> source 'default', gitIdentity omitted
  as(member)
  const initialView = await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()
  assert.deepEqual(initialView.values.gitAuthorName, { value: '', source: 'default' })
  assert.deepEqual(initialView.values.gitAuthorEmail, { value: '', source: 'default' })
  assert.equal((await readCliRunPolicy(pool, runId, member)).gitIdentity, undefined)

  // Non-admin member cannot write workspace gitAuthorName/Email; outsider cannot read or write
  assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ gitAuthorName: 'Forbidden' })), context())).status, 403)
  as(outsider)
  assert.equal((await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ gitAuthorName: 'Outsider' })))).status, 403)
  assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ gitAuthorName: 'Outsider' })), context())).status, 403)

  // Admin writes workspace defaults -> member inherits { value, source: 'workspace' } and readCliRunPolicy delivers them
  as(owner)
  const wsPatch = await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({
    gitAuthorName: 'Team Publisher',
    gitAuthorEmail: 'publish@team.example',
  })), context())
  assert.equal(wsPatch.status, 200)
  const wsData = await wsPatch.json()
  assert.deepEqual(wsData.values.gitAuthorName, { value: 'Team Publisher', source: 'workspace' })
  assert.deepEqual(wsData.values.gitAuthorEmail, { value: 'publish@team.example', source: 'workspace' })

  as(member)
  const inheritedView = await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()
  assert.deepEqual(inheritedView.values.gitAuthorName, { value: 'Team Publisher', source: 'workspace' })
  assert.deepEqual(inheritedView.values.gitAuthorEmail, { value: 'publish@team.example', source: 'workspace' })
  assert.deepEqual((await readCliRunPolicy(pool, runId, member)).gitIdentity, {
    name: 'Team Publisher',
    email: 'publish@team.example',
  })

  // Member sets personal gitAuthorName override and explicit "" override on gitAuthorEmail
  const ownPatch = await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({
    gitAuthorName: 'Member Personal',
    gitAuthorEmail: '',
  })))
  assert.equal(ownPatch.status, 200)
  const ownData = await ownPatch.json()
  assert.deepEqual(ownData.values.gitAuthorName, { value: 'Member Personal', source: 'personal' })
  assert.deepEqual(ownData.values.gitAuthorEmail, { value: '', source: 'personal' })
  assert.deepEqual((await readCliRunPolicy(pool, runId, member)).gitIdentity, {
    name: 'Member Personal',
  })

  // Personal reset of 'git' group restores inheritance from workspace
  const resetOwn = await personalReset.POST(request(`personal/reset?workspaceId=${workspaceId}`, 'POST', { group: 'git' }))
  assert.equal(resetOwn.status, 200)
  assert.deepEqual((await resetOwn.json()).values.gitAuthorEmail, { value: 'publish@team.example', source: 'workspace' })
  assert.deepEqual((await readCliRunPolicy(pool, runId, member)).gitIdentity, {
    name: 'Team Publisher',
    email: 'publish@team.example',
  })

  // Workspace reset of 'git' group restores product defaults
  as(owner)
  const resetWs = await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'git' }), context())
  assert.equal(resetWs.status, 200)
  assert.deepEqual((await resetWs.json()).values.gitAuthorName, { value: '', source: 'default' })
  assert.equal((await readCliRunPolicy(pool, runId, member)).gitIdentity, undefined)

  // Schema route includes gitAuthorName and gitAuthorEmail
  const schemaJson = await (await schemaRoute.GET(request('schema'))).json()
  assert.ok(schemaJson.settings.some((entry: { key: string; page: string }) => entry.key === 'gitAuthorName' && entry.page === 'git'))
  assert.ok(schemaJson.settings.some((entry: { key: string; page: string }) => entry.key === 'gitAuthorEmail' && entry.page === 'git'))
})
