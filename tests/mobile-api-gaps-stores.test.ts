// Store-level regression tests for the mobile API gap writers and readers:
// - contiguous SQL parameter binding + enterprise gate in `searchMobileMessages`
// - lean metadata projection (no `inlineData`/`textContent`) + enterprise gate in `readMobileAttachments`
// - non-mutating `readonly` workspace check, team-PAT briefing suppression, safe error logs in `readMobileProactiveCards`
// - suggestion Bot workspace resolution & mismatch refusal in `resolveSuggestionStartWorkspace`/`startSuggestion`
// - streaming multipart byte cap without Content-Length in `readMobileAvatarPayload`
import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { ChatFileError } from '../lib/chat-attachments/extract'
import { enterprisePrincipal } from '../lib/enterprise/principal'
import { MobileAvatarError, readMobileAvatarPayload } from '../lib/mobile-profile-contract'
import { tokenWorkspace } from '../lib/tokens/principal'
import { WorkspaceError } from '../lib/workspace-error'

const WS_PERSONAL = '11111111-1111-4111-8111-111111111111'
const WS_TEAM = '22222222-2222-4222-8222-222222222222'
const BOT_1 = '33333333-3333-4333-8333-333333333333'
const CONV_1 = '44444444-4444-4444-8444-444444444444'
const ATT_1 = '55555555-5555-4555-8555-555555555555'
const SUG_1 = '66666666-6666-4666-8666-666666666666'

let memberExists = true
let enterpriseAllowed = true
let effectiveWorkspace: string | null = WS_PERSONAL
let loadContextCalls = 0
let personalWorkspaceIds = new Set([WS_PERSONAL])
let activeTaskWorkspacesResult: Array<{ id: string; kind: 'personal' | 'team' }> = [{ id: WS_PERSONAL, kind: 'personal' }]
let fileScopeWorkspace = WS_PERSONAL
let poolQueries: Array<{ sql: string; params: unknown[] }> = []
let poolQueryResponder: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] })
let afterJobs: Array<{ name: string; fn: () => Promise<unknown> | unknown }> = []
let todaysBriefingCalls = 0
let dbBriefingRows: unknown[] = []
let composioError: Error | null = null

let searchMod: typeof import('../lib/mobile-message-search')
let attachmentsMod: typeof import('../lib/mobile-attachments')
let proactiveMod: typeof import('../lib/mobile-proactive-cards')
let suggestionsMod: typeof import('../lib/cloud-computer/suggestions')

function assertContiguousSqlParams(sql: string, params: unknown[]) {
  const referenced = new Set<number>()
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    referenced.add(Number(match[1]))
  }
  assert.ok(params.length > 0, 'query must bind parameters')
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `parameter $${i} is bound (count=${params.length}) but never referenced in SQL`)
  }
  for (const idx of referenced) {
    assert.ok(idx >= 1 && idx <= params.length, `SQL references $${idx} outside bound params length ${params.length}`)
  }
}

before(async () => {
  const makeClient = () => ({
    query: async (sql: string, params: unknown[] = []) => {
      poolQueries.push({ sql, params })
      return poolQueryResponder(sql, params)
    },
    release: () => {},
  })

  mock.module('@/lib/db', {
    namedExports: {
      pool: {
        query: async (sql: string, params: unknown[] = []) => {
          poolQueries.push({ sql, params })
          return poolQueryResponder(sql, params)
        },
        connect: async () => makeClient(),
      },
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => dbBriefingRows,
              }),
            }),
          }),
        }),
      },
    },
  })

  mock.module('@/lib/workspace-db', {
    namedExports: {
      workspaceDb: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (memberExists ? [{ id: 'user-1' }] : []),
            }),
          }),
        }),
      },
      workspacePool: { query: async () => ({ rows: [], rowCount: 0 }) },
    },
  })

  mock.module('@/lib/enterprise/access', {
    namedExports: {
      enterpriseWorkspaceAllowed: async () => enterpriseAllowed,
    },
  })

  mock.module('@/lib/request-workspace', {
    namedExports: {
      effectiveRequestWorkspace: async () => effectiveWorkspace,
    },
  })

  mock.module('@/lib/workspace-access', {
    namedExports: {
      WorkspaceError,
      loadWorkspaceContext: async () => {
        loadContextCalls++
        return { workspace: { id: WS_TEAM, name: 'Team', kind: 'team' } }
      },
    },
  })

  mock.module('@/lib/task-workspace', {
    namedExports: {
      activeTaskWorkspaces: async () => activeTaskWorkspacesResult,
      requireTaskWorkspaceLease: async () => ({ close: async () => {} }),
      withTaskWorkspace: async (_user: unknown, _ws: string, fn: () => Promise<unknown>) => fn(),
    },
  })

  mock.module('@/lib/tokens/scope', {
    namedExports: {
      isPersonalWorkspace: async (_userId: string, wsId: string) => personalWorkspaceIds.has(wsId),
      pendingActionsOutsideToken: async () => new Set<string>(),
      suggestionsOutsideToken: async () => new Set<string>(),
    },
  })

  mock.module('@/lib/background', {
    namedExports: {
      afterJob: (name: string, fn: () => unknown) => {
        afterJobs.push({ name, fn })
      },
    },
  })

  mock.module('@/lib/pending-action-store', {
    namedExports: {
      listPendingActions: async () => [],
    },
  })

  mock.module('@/lib/suggestions/sources', {
    namedExports: {
      ensureComposioTriggers: async () => {
        if (composioError) throw composioError
      },
    },
  })

  mock.module('@/lib/suggestions/action-title-server', {
    namedExports: {
      rememberLocale: async () => {},
    },
  })

  mock.module('@/lib/suggestions/time-zone', {
    namedExports: {
      manualTimeZone: async () => null,
    },
  })

  mock.module('@/lib/suggestions/store', {
    namedExports: {
      listSuggestions: async () => [],
      recordTimeZone: async () => {},
      todaysBriefing: async () => {
        todaysBriefingCalls++
        return {
          localDate: '2026-11-24',
          kind: 'daily',
          total: 3,
          counts: { github: 3 },
          highlights: [SUG_1],
          createdAt: new Date('2026-11-24T08:00:00Z'),
        }
      },
    },
  })

  mock.module('@/lib/chat-attachments/store', {
    namedExports: {
      authorizeFileScope: async () => fileScopeWorkspace,
      chatFileDownloadUrl: async () => 'https://r2.example.invalid/signed',
      fileScope: (row: { botId?: string | null; conversationId?: string | null; runId?: string | null }) =>
        row.botId
          ? { kind: 'bot', id: row.botId }
          : row.conversationId
            ? { kind: 'group', id: row.conversationId }
            : { kind: 'thread', id: row.runId! },
    },
  })

  mock.module('@/lib/api-auth', {
    namedExports: {
      apiWorkspaceAllowed: (session: { tokenWorkspaceId?: string }, wsId: string) =>
        !session.tokenWorkspaceId || session.tokenWorkspaceId === wsId,
    },
  })

  searchMod = await import('../lib/mobile-message-search')
  attachmentsMod = await import('../lib/mobile-attachments')
  proactiveMod = await import('../lib/mobile-proactive-cards')
  suggestionsMod = await import('../lib/cloud-computer/suggestions')
})

beforeEach(() => {
  memberExists = true
  enterpriseAllowed = true
  effectiveWorkspace = WS_PERSONAL
  loadContextCalls = 0
  personalWorkspaceIds = new Set([WS_PERSONAL])
  activeTaskWorkspacesResult = [{ id: WS_PERSONAL, kind: 'personal' }]
  fileScopeWorkspace = WS_PERSONAL
  poolQueries = []
  poolQueryResponder = () => ({ rows: [] })
  afterJobs = []
  todaysBriefingCalls = 0
  dbBriefingRows = [
    {
      localDate: '2026-11-24',
      kind: 'daily',
      total: 2,
      counts: { github: 2 },
      highlights: [SUG_1],
      createdAt: new Date('2026-11-24T08:00:00Z'),
    },
  ]
  composioError = null
})

test('searchMobileMessages binds contiguous SQL parameters for every scope and target filter, and enforces enterprise assurance', async () => {
  const user = { id: 'user-1', [enterprisePrincipal]: { kind: 'session' as const, sessionId: 'sess-1' } }

  const cases = [
    { scope: 'all' as const, botId: null, conversationId: null },
    { scope: 'bot' as const, botId: null, conversationId: null },
    { scope: 'bot' as const, botId: BOT_1, conversationId: null },
    { scope: 'group' as const, botId: null, conversationId: null },
    { scope: 'group' as const, botId: null, conversationId: CONV_1 },
    { scope: 'thread' as const, botId: null, conversationId: null },
  ]

  for (const variant of cases) {
    poolQueries = []
    await searchMod.searchMobileMessages(user, {
      q: 'deploy',
      workspaceId: WS_TEAM,
      scope: variant.scope,
      botId: variant.botId,
      conversationId: variant.conversationId,
      limit: 20,
      cursor: null,
    })
    assert.equal(poolQueries.length, 1, `expected 1 SQL query for ${JSON.stringify(variant)}`)
    assertContiguousSqlParams(poolQueries[0].sql, poolQueries[0].params)
  }

  // Enterprise policy denial must reject search before querying messages.
  enterpriseAllowed = false
  poolQueries = []
  await assert.rejects(
    searchMod.searchMobileMessages(user, {
      q: 'secret',
      workspaceId: WS_TEAM,
      scope: 'all',
      botId: null,
      conversationId: null,
      limit: 20,
      cursor: null,
    }),
    searchMod.MobileMessageSearchAccessError,
  )
  assert.equal(poolQueries.length, 0)
})

test('readMobileAttachments never selects inlineData/textContent and enforces enterprise workspace assurance', async () => {
  const session = {
    user: {
      id: 'user-1',
      name: 'Alex',
      email: 'alex@example.com',
      image: null,
      [enterprisePrincipal]: { kind: 'session' as const, sessionId: 'sess-1' },
    },
    session: { id: 'sess-1' },
  }
  poolQueryResponder = () => ({
    rows: [
      {
        id: ATT_1,
        userId: 'user-1',
        botId: BOT_1,
        conversationId: null,
        runId: null,
        name: 'spec.pdf',
        mediaType: 'application/pdf',
        size: 1024,
        storageKey: 'uploads/spec.pdf',
        usedAt: new Date('2026-11-24T10:00:00Z'),
        createdAt: new Date('2026-11-24T10:00:00Z'),
      },
    ],
  })

  const scopeItems = await attachmentsMod.readMobileAttachments(session, {
    kind: 'scope',
    scope: { kind: 'bot', id: BOT_1 },
    limit: 20,
    download: false,
  })
  assert.equal(scopeItems.length, 1)
  assert.doesNotMatch(poolQueries[0].sql, /inlineData|textContent/)

  poolQueries = []
  const batchItems = await attachmentsMod.readMobileAttachments(session, {
    kind: 'ids',
    ids: [ATT_1],
    download: true,
  })
  assert.equal(batchItems.length, 1)
  assert.doesNotMatch(poolQueries[0].sql, /inlineData|textContent/)

  // Enterprise denial blocks scope listing and omits unauthorized items from batch lookups.
  enterpriseAllowed = false
  await assert.rejects(
    attachmentsMod.readMobileAttachments(session, {
      kind: 'scope',
      scope: { kind: 'bot', id: BOT_1 },
      limit: 20,
      download: false,
    }),
    (err: unknown) => err instanceof ChatFileError && err.code === 'notFound',
  )
  const hiddenBatch = await attachmentsMod.readMobileAttachments(session, {
    kind: 'ids',
    ids: [ATT_1],
    download: false,
  })
  assert.deepEqual(hiddenBatch, [])
})

test('readMobileProactiveCards avoids mutating workspaces on readonly, hides personal briefing for team PATs, and logs error names only', async () => {
  const sessionUser = {
    id: 'user-1',
    name: 'Alex',
    email: 'alex@example.com',
    image: null,
    [enterprisePrincipal]: { kind: 'session' as const, sessionId: 'sess-1' },
  }

  // Readonly check uses non-mutating effectiveRequestWorkspace and skips writes.
  const readonlyRes = await proactiveMod.readMobileProactiveCards(sessionUser, { readonly: true })
  assert.equal(readonlyRes.workspaceId, WS_PERSONAL)
  assert.equal(loadContextCalls, 0)
  assert.equal(afterJobs.length, 0)
  assert.equal(todaysBriefingCalls, 0)
  assert.ok(readonlyRes.briefing)

  // Missing authorized workspace on readonly throws WorkspaceError.
  effectiveWorkspace = null
  await assert.rejects(
    proactiveMod.readMobileProactiveCards(sessionUser, { readonly: true }),
    WorkspaceError,
  )
  effectiveWorkspace = WS_TEAM

  // Team-scoped PAT never receives personal briefing.
  const teamPatUser = {
    ...sessionUser,
    [tokenWorkspace]: WS_TEAM,
  }
  const teamRes = await proactiveMod.readMobileProactiveCards(teamPatUser, { readonly: false })
  assert.equal(teamRes.briefing, null)
  assert.equal(todaysBriefingCalls, 0)

  // Background error logging omits raw error.message.
  const logged: unknown[][] = []
  const origError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    composioError = new TypeError('secret-bearer-token-leaked-in-message')
    await afterJobs[0].fn()
  } finally {
    console.error = origError
  }
  assert.equal(logged.length, 1)
  assert.deepEqual(logged[0][1], { name: 'TypeError' })
  assert.equal(JSON.stringify(logged).includes('secret-bearer-token'), false)
})

test('resolveSuggestionStartWorkspace resolves Bot owning workspace and startSuggestion refuses cross-workspace mismatch', async () => {
  const user = { id: 'user-1' }
  poolQueryResponder = (sql: string) => {
    if (sql.includes('FROM suggestions s')) {
      return { rows: [{ botId: BOT_1, workspaceId: WS_PERSONAL }] }
    }
    if (sql.includes('FROM suggestions WHERE id=$1')) {
      return {
        rows: [
          {
            id: SUG_1,
            userId: 'user-1',
            botId: BOT_1,
            source: 'github',
            actor: 'alex',
            url: 'https://example.invalid',
            title: 'PR #1',
            action: 'review',
            actionTitle: 'Review PR #1',
          },
        ],
      }
    }
    if (sql.includes('SELECT "workspaceId" FROM bots WHERE id=$1')) {
      return { rows: [{ workspaceId: WS_PERSONAL }] }
    }
    return { rows: [] }
  }

  // Even when the user is viewing a team workspace, a personal suggestion resolves to its Bot's personal workspace.
  const resolved = await suggestionsMod.resolveSuggestionStartWorkspace(
    { query: async (sql: string, params: unknown[] = []) => poolQueryResponder(sql, params) } as never,
    user,
    SUG_1,
  )
  assert.equal(resolved, WS_PERSONAL)

  // Calling startSuggestion with a mismatched workspaceId is refused before creating an execution row.
  const fakePool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => poolQueryResponder(sql, params),
      release: () => {},
    }),
  } as never
  await assert.rejects(
    suggestionsMod.startSuggestion(fakePool, { userId: 'user-1', workspaceId: WS_TEAM }, SUG_1),
    { status: 404 },
  )
})

test('readMobileAvatarPayload rejects oversized streaming multipart uploads without Content-Length before buffering', async () => {
  let chunksProduced = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksProduced++
      if (chunksProduced > 100) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(32 * 1024).fill(0x41))
    },
    cancel() {
      cancelled = true
    },
  })

  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=----test' },
    body: stream,
    duplex: 'half',
  }
  const req = new Request('https://mikka.test/api/mobile/profile/avatar', init)

  await assert.rejects(
    readMobileAvatarPayload(req),
    (err: unknown) => err instanceof MobileAvatarError && err.code === 'avatarTooLarge' && err.status === 413,
  )
  assert.equal(cancelled, true, 'oversized multipart stream must be cancelled early')
  assert.ok(chunksProduced < 20, `expected early abort well before 100 chunks, got ${chunksProduced}`)
})
