import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import { DND_DAYS, inDndWindow, pushAllowed } from '@/lib/push-allowed'
import { SETTINGS_REGISTRY } from '@/lib/settings/registry'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('WS-C DB tests require an isolated loopback *_e2e database')
const dbTest = available ? test : test.skip

const userA = `wsc-owner-${randomUUID()}`
const userB = `wsc-peer-${randomUUID()}`
const outsider = `wsc-outsider-${randomUUID()}`
const unverifiedUser = `wsc-unverified-${randomUUID()}`
const allUsers = [userA, userB, outsider, unverifiedUser]
const workspaceA = randomUUID()
const workspaceB = randomUUID()
const foreignWorkspace = randomUUID()
const homes = new Map<string, string>()

let currentUser: { id: string; email: string; name: string } | null = null
let sessionId = `wsc-session-${randomUUID()}`
let expoBodies: Record<string, unknown>[][] = []

let pool: (typeof import('@/lib/db'))['pool']
let workspacePool: (typeof import('@/lib/workspace-db'))['workspacePool']
let personalRoute: typeof import('@/app/api/settings/personal/route')
let personalResetRoute: typeof import('@/app/api/settings/personal/reset/route')
let workspaceRoute: typeof import('@/app/api/settings/workspace/[workspaceId]/route')
let schemaRoute: typeof import('@/app/api/settings/schema/route')

const asUser = (userId: string | null) => {
  currentUser = userId ? { id: userId, email: `${userId}@example.invalid`, name: userId } : null
}
const request = (path: string, method = 'GET', body?: unknown) => new Request(`http://127.0.0.1/api/settings/${path}`, {
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
})
const context = (id = workspaceA) => ({ params: Promise.resolve({ workspaceId: id }) })
const patch = (values: Record<string, unknown>) => ({ values })

const WS_C_KEYS = [
  'memoryAutoApprove',
  'dndEnabled',
  'dndStart',
  'dndEnd',
  'dndDays',
  'notifyMobileDecide',
  'notifyMobileReview',
  'notifyMobileFinished',
  'notifyMobileBriefing',
  'notifyDesktopDecide',
  'notifyDesktopReview',
  'notifyDesktopFinished',
  'notifyDesktopBriefing',
  'notifyEmailInvitations',
  'notificationSound',
] as const

before(async () => {
  if (!available) return
  process.env.WORKSPACE_SECRETS_KEY ??= randomBytes(32).toString('base64')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === 'https://exp.host/--/api/v2/push/send') {
      const payload = JSON.parse(String(init?.body ?? '[]')) as Record<string, unknown>[]
      expoBodies.push(payload)
      return Response.json({ data: payload.map((_, idx) => ({ status: 'ok', id: `ticket-${idx}` })) })
    }
    return originalFetch(input, init)
  }) as typeof fetch

  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/intl/i18n-server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  mock.module('@/lib/session', { namedExports: { getSession: async () => currentUser ? { user: currentUser, session: { id: sessionId } } : null } })
  mock.module('@/lib/api-auth', { namedExports: {
    auth: { api: { getSession: async () => currentUser ? { user: currentUser, session: { id: sessionId } } : null } },
    getApiSession: async () => currentUser ? { user: currentUser, session: { id: sessionId } } : null,
    apiWorkspaceAllowed: (session: { tokenWorkspaceId?: string }, workspaceId: string) =>
      !session.tokenWorkspaceId || session.tokenWorkspaceId === workspaceId,
  } })
  mock.module('@/lib/auth', { namedExports: {
    authBaseURL: 'http://127.0.0.1',
    googleEnabled: false,
    githubSignInEnabled: false,
    auth: { api: { getSession: async () => currentUser ? { user: currentUser, session: { id: sessionId } } : null } },
  } })
  mock.module('workflow/api', { namedExports: { start: async () => {} } })
  mock.module('@/lib/coordinator/decide', { namedExports: {
    invokeDecision: async () => null,
    decide: async (_kind: string, _source: string, questions: { name: string }[]) =>
      new Map(questions.map(q => [q.name, { type: 'predicate', name: q.name, probability: 1 }])),
  } })

  ;({ pool } = await import('@/lib/db'))
  ;({ workspacePool } = await import('@/lib/workspace-db'))
  personalRoute = await import('@/app/api/settings/personal/route')
  personalResetRoute = await import('@/app/api/settings/personal/reset/route')
  workspaceRoute = await import('@/app/api/settings/workspace/[workspaceId]/route')
  schemaRoute = await import('@/app/api/settings/schema/route')

  for (const id of allUsers) {
    const verified = id !== unverifiedUser
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,$3,now(),now())', [id, `${id}@example.invalid`, verified])
    const home = randomUUID()
    homes.set(id, home)
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,$3,\'personal\')', [home, id, 'Personal'])
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [home, id, `${id}@example.invalid`])
  }
  await pool.query('INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 day\',now(),now())', [sessionId, `tok-${sessionId}`, userA])

  for (const [ws, creator] of [[workspaceA, userA], [workspaceB, userA], [foreignWorkspace, outsider]] as const) {
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Team\',\'team\')', [ws, creator])
  }
  for (const [ws, person, role] of [
    [workspaceA, userA, 'admin'],
    [workspaceA, userB, 'member'],
    [workspaceB, userA, 'admin'],
    [foreignWorkspace, outsider, 'admin'],
  ] as const) {
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,$4,\'active\')', [ws, person, `${person}@example.invalid`, role])
  }
})

after(async () => {
  if (!available) return
  const workspaceIds = [workspaceA, workspaceB, foreignWorkspace, ...homes.values()]
  await pool.query('DELETE FROM mobile_push_receipts WHERE user_id=ANY($1)', [allUsers])
  await pool.query('DELETE FROM mobile_push_tokens WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM user_fact_undo WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM user_facts WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM user_time_zones WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM user_preferences WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM attention_settings WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM personal_setting_values WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM workspace_setting_values WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM "session" WHERE id=$1', [sessionId])
  await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [allUsers])
  await (await import('@/lib/builtin-gateway/runtime')).builtinGateway()?.stop()
  await Promise.all([pool.end(), workspacePool.end()])
})

dbTest('all 15 WS-C registry keys resolve defaults, persist account-wide overrides via REST & Desktop RPC, and reset cleanly', async () => {
  const { desktopActions } = await import('@/lib/desktop-rpc/registry')
  const callRpc = async (name: keyof typeof desktopActions, args: unknown[]) => {
    const entry = desktopActions[name]
    return entry.invoke(entry.args.parse(args) as never) as Promise<Record<string, unknown>>
  }
  asUser(userA)

  const schemaRes = await schemaRoute.GET(request('schema'))
  assert.equal(schemaRes.status, 200)
  const schemaBody = await schemaRes.json()
  for (const key of WS_C_KEYS) {
    assert.ok(schemaBody.settings.some((entry: { key: string }) => entry.key === key), `${key} present in GET /api/settings/schema`)
  }

  const initial = await (await personalRoute.GET(request(`personal?workspaceId=${workspaceA}`))).json()
  for (const key of WS_C_KEYS) {
    assert.deepEqual(initial.values[key], { value: SETTINGS_REGISTRY[key].defaultValue, source: 'default' })
  }

  const overrides = {
    memoryAutoApprove: true,
    dndEnabled: true,
    dndStart: '23:15',
    dndEnd: '07:45',
    dndDays: ['mon', 'wed', 'fri'],
    notifyMobileDecide: false,
    notifyMobileReview: true,
    notifyMobileFinished: false,
    notifyMobileBriefing: false,
    notifyDesktopDecide: true,
    notifyDesktopReview: false,
    notifyDesktopFinished: true,
    notifyDesktopBriefing: false,
    notifyEmailInvitations: false,
    notificationSound: 'subtle',
  }
  const patchedRes = await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch(overrides)))
  assert.equal(patchedRes.status, 200)
  const patched = await patchedRes.json()
  for (const [key, value] of Object.entries(overrides)) {
    assert.deepEqual(patched.values[key], { value, source: 'personal' }, `${key} saved with personal source`)
  }

  // Account-scoped personal settings carry across workspaces of the same owner, never leaking to another member.
  const inWorkspaceB = await callRpc('settings.getSettings', [workspaceB])
  assert.equal('values' in inWorkspaceB, true)
  const valuesB = inWorkspaceB.values as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    assert.deepEqual(valuesB[key], { value, source: 'personal' })
  }

  asUser(userB)
  const peerView = await (await personalRoute.GET(request(`personal?workspaceId=${workspaceA}`))).json()
  for (const key of WS_C_KEYS) {
    assert.deepEqual(peerView.values[key], { value: SETTINGS_REGISTRY[key].defaultValue, source: 'default' }, `userB never sees userA's ${key}`)
  }

  // Reset groups via REST and Desktop RPC
  asUser(userA)
  const resetMemory = await personalResetRoute.POST(request(`personal/reset?workspaceId=${workspaceA}`, 'POST', { group: 'memory' }))
  assert.equal(resetMemory.status, 200)
  assert.deepEqual((await resetMemory.json()).values.memoryAutoApprove, { value: false, source: 'default' })

  const resetNotify = await callRpc('settings.resetPersonalSettings', [{ group: 'notifications' }, workspaceA])
  assert.equal('values' in resetNotify, true)
  const resetValues = resetNotify.values as Record<string, unknown>
  for (const key of WS_C_KEYS.filter(k => k !== 'memoryAutoApprove')) {
    assert.deepEqual(resetValues[key], { value: SETTINGS_REGISTRY[key].defaultValue, source: 'default' })
  }
})

dbTest('unauthorized, cross-workspace, cross-user, and workspace-scope writes are rejected across REST and Desktop RPC', async () => {
  const { desktopActions } = await import('@/lib/desktop-rpc/registry')
  const callRpc = async (name: keyof typeof desktopActions, args: unknown[]) => {
    const entry = desktopActions[name]
    return entry.invoke(entry.args.parse(args) as never) as Promise<Record<string, unknown>>
  }

  asUser(null)
  assert.equal((await personalRoute.GET(request(`personal?workspaceId=${workspaceA}`))).status, 401)
  assert.equal((await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({ memoryAutoApprove: true })))).status, 401)
  assert.equal((await personalResetRoute.POST(request(`personal/reset?workspaceId=${workspaceA}`, 'POST', { group: 'notifications' }))).status, 401)

  // Cross-workspace outsider rejected with 403
  asUser(outsider)
  assert.equal((await personalRoute.GET(request(`personal?workspaceId=${workspaceA}`))).status, 403)
  assert.equal((await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({ dndEnabled: true })))).status, 403)
  assert.equal((await personalResetRoute.POST(request(`personal/reset?workspaceId=${workspaceA}`, 'POST', { group: 'memory' }))).status, 403)
  const rpcCrossWs = await callRpc('settings.patchPersonalSettings', [patch({ memoryAutoApprove: true }), workspaceA])
  assert.equal(rpcCrossWs.error, 'workspaceAccessDenied')

  // Cross-user target injection rejected with 400; userA's value remains default
  asUser(userB)
  const injected = await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', {
    userId: userA,
    values: { memoryAutoApprove: true },
  }))
  assert.equal(injected.status, 400)
  asUser(userA)
  assert.deepEqual((await (await personalRoute.GET(request(`personal?workspaceId=${workspaceA}`))).json()).values.memoryAutoApprove, {
    value: false,
    source: 'default',
  })

  // Workspace admin cannot write personal-only WS-C fields at workspace scope
  for (const key of ['memoryAutoApprove', 'dndEnabled', 'notifyMobileDecide', 'notifyDesktopFinished', 'notifyEmailInvitations', 'notificationSound'] as const) {
    const wsWrite = await workspaceRoute.PATCH(
      request(`workspace/${workspaceA}`, 'PATCH', patch({ [key]: SETTINGS_REGISTRY[key].defaultValue })),
      context(workspaceA),
    )
    assert.equal(wsWrite.status, 400, `${key} rejected at workspace scope`)
  }
})

dbTest('memoryAutoApprove governs extracted facts while self-added facts stay approved and slot conflicts stay pending', async () => {
  const memory = await import('@/lib/profile/memory')
  const profile = await import('@/lib/profile/store')
  const { getMemory } = await import('@/app/actions/memory')
  const at = new Date('2026-11-21T12:00:00Z')

  await pool.query('DELETE FROM user_facts WHERE "userId"=ANY($1)', [[userA, userB]])
  await pool.query('DELETE FROM personal_setting_values WHERE "userId"=ANY($1)', [[userA, userB]])

  // 1. Default autoApprove=false: self-added ('told') is approved; extracted is pending.
  asUser(userA)
  const selfId = await memory.addMemoryFact(userA, workspaceA, {
    requestId: randomUUID(),
    kind: 'preference',
    subject: 'Always run tests first',
    scope: { kind: 'global', ids: [] },
  })
  assert.ok(selfId)
  assert.equal(await profile.recordFacts(userA, [{
    kind: 'tool', subject: 'Uses ripgrep', value: {}, evidence: [], confidence: 0.8, seenAt: at, expiresAt: null,
  }]), 1)

  let memView = await getMemory()
  assert.equal(memView.autoApprove, false)
  assert.deepEqual(memView.facts.map(f => f.subject), ['Always run tests first'])
  assert.deepEqual(memView.pending.map(f => f.subject), ['Uses ripgrep'])
  assert.doesNotMatch(await profile.profilePromptSection(userA, []), /Uses ripgrep/)

  // 2. Enable memoryAutoApprove=true for userA (userB remains default false).
  await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({ memoryAutoApprove: true })))
  assert.equal((await getMemory()).autoApprove, true)

  // Non-conflicting extracted fact (no slot) -> approved
  assert.equal(await profile.recordFacts(userA, [{
    kind: 'tool', subject: 'Uses fd-find', value: {}, evidence: [], confidence: 0.8, seenAt: at, expiresAt: null,
  }]), 1)
  // First extracted fact in slot 'package_manager' -> approved
  assert.equal(await profile.recordFacts(userA, [{
    kind: 'preference', subject: 'Package manager: pnpm', value: { slot: 'package_manager' }, evidence: [], confidence: 0.8, seenAt: at, expiresAt: null,
  }]), 1)
  // Contradicting extracted fact in same slot 'package_manager' (same repository=null) -> stays pending!
  assert.equal(await profile.recordFacts(userA, [{
    kind: 'preference', subject: 'Package manager: yarn', value: { slot: 'package_manager' }, evidence: [], confidence: 0.8, seenAt: at, expiresAt: null,
  }]), 1)
  // Same slot name in a DIFFERENT repository is independent, not a contradiction -> approved!
  assert.equal(await profile.recordFacts(userA, [{
    kind: 'preference', subject: 'Package manager: cargo', repository: 'acme/rust-svc', value: { slot: 'package_manager' }, evidence: [], confidence: 0.8, seenAt: at, expiresAt: null,
  }]), 1)

  memView = await getMemory()
  const approvedSubjects = memView.facts.map(f => f.subject)
  const pendingSubjects = memView.pending.map(f => f.subject)
  assert.ok(approvedSubjects.includes('Always run tests first'))
  assert.ok(approvedSubjects.includes('Uses fd-find'))
  assert.ok(approvedSubjects.includes('Package manager: pnpm'))
  assert.ok(approvedSubjects.includes('Package manager: cargo'))
  assert.equal(approvedSubjects.includes('Package manager: yarn'), false, 'slot-contradicting fact must not auto-approve')
  assert.ok(pendingSubjects.includes('Package manager: yarn'), 'slot-contradicting fact stays pending for review')

  const promptText = await profile.profilePromptSection(userA, [])
  assert.match(promptText, /Uses fd-find/)
  assert.match(promptText, /Package manager: pnpm/)
  assert.doesNotMatch(promptText, /Package manager: yarn/)

  // 3. userB remains unaffected by userA's memoryAutoApprove=true.
  assert.equal(await profile.recordFacts(userB, [{
    kind: 'tool', subject: 'UserB unapproved tool', value: {}, evidence: [], confidence: 0.8, seenAt: at, expiresAt: null,
  }]), 1)
  assert.equal((await memory.readMemoryView(userB, workspaceA)).pending.length, 1)
  assert.equal((await memory.readMemoryView(userB, workspaceA)).facts.length, 0)
})

dbTest('scheduled DND, channel x category matrix, sound preset, and legacy user_preferences fallback enforce end-to-end', async () => {
  const { savePreferences, readPreferences } = await import('@/lib/preferences')
  const { writeTimeZoneSetting } = await import('@/lib/suggestions/time-zone')
  const { readNotificationRuntimeSettings } = await import('@/lib/settings/notification-preferences')
  const { sendOrganizationInvitationEmails } = await import('@/lib/governance/organization-invitation-mail')
  const { chooseDesktopNotifications } = await import('@/app/actions/desktop-notifications')
  const { pushReply } = await import('@/lib/mobile-push')

  await pool.query('DELETE FROM personal_setting_values WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM user_preferences WHERE "userId"=ANY($1)', [allUsers])
  await pool.query('DELETE FROM user_time_zones WHERE "userId"=ANY($1)', [allUsers])

  // 1. Legacy fallback: userA sets legacy pushFinished=false & organizationInvitationEmails=false
  await savePreferences(userA, { pushFinished: false, organizationInvitationEmails: false })
  await savePreferences(unverifiedUser, { organizationInvitationEmails: false })
  let prefsA = await readPreferences(userA)
  let runtimeA = await readNotificationRuntimeSettings(userA)
  assert.equal(pushAllowed(prefsA, ['finished'], { overrides: runtimeA.mobile, dnd: runtimeA.dnd, timeZone: runtimeA.timeZone }), false)
  assert.equal(pushAllowed(prefsA, ['decide'], { overrides: runtimeA.mobile, dnd: runtimeA.dnd, timeZone: runtimeA.timeZone }), true)

  // Email invitations: verified userA suppressed via legacy fallback; unverifiedUser cannot suppress
  const sentEmails: string[] = []
  const outcomes = [userA, userB, unverifiedUser].map((u, idx) => ({
    created: true as const,
    id: randomUUID(),
    email: `${u}@example.invalid`,
    path: `/organization-invite/${String(idx + 1).repeat(64).slice(0, 64)}`,
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  }))
  await sendOrganizationInvitationEmails(outcomes, 'https://app.example.test', async msg => { sentEmails.push(msg.to) })
  assert.deepEqual(sentEmails.sort(), [`${userB}@example.invalid`, `${unverifiedUser}@example.invalid`].sort())

  // 2. Explicit notifyEmailInvitations override in personal_setting_values wins over legacy user_preferences
  asUser(userA)
  await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({ notifyEmailInvitations: true })))
  asUser(userB)
  await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({ notifyEmailInvitations: false })))
  sentEmails.length = 0
  await sendOrganizationInvitationEmails(outcomes, 'https://app.example.test', async msg => { sentEmails.push(msg.to) })
  assert.deepEqual(sentEmails.sort(), [`${userA}@example.invalid`, `${unverifiedUser}@example.invalid`].sort())

  // 3. Desktop vs Mobile independent channel overrides + real chooseDesktopNotifications & pushReply
  asUser(userA)
  const issueFinished = randomUUID()
  const issueAwaiting = randomUUID()
  const runFinished = randomUUID()
  const runAwaiting = randomUUID()
  const homeA = homes.get(userA)!
  const agentId = randomUUID()
  const botId = randomUUID()
  await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'Codex\',\'codex\')', [agentId, userA])
  await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Notify Bot\')', [botId, userA, homeA])
  await pool.query('INSERT INTO mobile_push_tokens (id,"userId","sessionId",token,platform,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,\'ios\',now(),now())', [
    randomUUID(), userA, sessionId, 'ExpoPushToken[wsc-device]',
  ])
  for (const [issueId, runId, status] of [[issueFinished, runFinished, 'succeeded'], [issueAwaiting, runAwaiting, 'waiting_input']] as const) {
    await pool.query('INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,\'Task\',\'{"type":"doc"}\',\'todo\',\'normal\')', [issueId, userA, homeA])
    await pool.query('INSERT INTO agent_runs (id,"userId","workspaceId","issueId","agentId","botId",prompt,status) VALUES ($1,$2,$3,$4,$5,$6,\'Run\',$7)', [runId, userA, homeA, issueId, agentId, botId, status])
  }

  // Enable desktop finished=true, desktop decide=false; mobile finished=false, mobile decide=true, notificationSound='none'
  await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({
    notifyDesktopFinished: true,
    notifyDesktopDecide: false,
    notifyMobileFinished: false,
    notifyMobileDecide: true,
    notificationSound: 'none',
  })))

  const desktopCandidates = [
    { id: `run:${issueFinished}:finished:1`, issueId: issueFinished, kind: 'finished' as const },
    { id: `run:${issueAwaiting}:awaiting:1`, issueId: issueAwaiting, kind: 'awaiting' as const },
  ]
  const desktopChoice = await chooseDesktopNotifications(desktopCandidates)
  assert.deepEqual(desktopChoice, { show: [`run:${issueFinished}:finished:1`] }, 'desktop allows finished override=true and suppresses decide override=false')

  const prevEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  try {
    expoBodies = []
    await pushReply(userA, botId, 'Finished work', ['finished'])
    assert.equal(expoBodies.length, 0, 'mobile finished=false suppresses phone push')

    await pushReply(userA, botId, 'Decision needed', ['decide'])
    assert.equal(expoBodies.length, 1, 'mobile decide=true delivers phone push')
    assert.equal(expoBodies[0]![0]!.sound, null, 'notificationSound=none sends silent push (sound: null)')

    // Switch sound to 'chime' -> system push uses 'default' sound
    await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({ notificationSound: 'chime' })))
    expoBodies = []
    await pushReply(userA, botId, 'Decision with chime', ['decide'])
    assert.equal(expoBodies.length, 1)
    assert.equal(expoBodies[0]![0]!.sound, 'default')

    // 4. Full-day scheduled DND in user's manual IANA timezone suppresses both mobile push and desktop notifications
    await writeTimeZoneSetting(userA, 'America/New_York')
    await personalRoute.PATCH(request(`personal?workspaceId=${workspaceA}`, 'PATCH', patch({
      dndEnabled: true,
      dndStart: '00:00',
      dndEnd: '00:00',
      dndDays: [...DND_DAYS],
    })))
    runtimeA = await readNotificationRuntimeSettings(userA)
    assert.equal(runtimeA.timeZone, 'America/New_York')
    assert.equal(inDndWindow(runtimeA.dnd, runtimeA.timeZone), true)

    expoBodies = []
    await pushReply(userA, botId, 'Muted during DND', ['decide'])
    assert.equal(expoBodies.length, 0, 'active DND suppresses mobile push')
    assert.deepEqual(await chooseDesktopNotifications(desktopCandidates), { show: [] }, 'active DND suppresses desktop notifications')
  } finally {
    if (prevEdition === undefined) delete process.env.MIKKA_EDITION
    else process.env.MIKKA_EDITION = prevEdition
  }
})
