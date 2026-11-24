// Route-level unit tests for the 6 mobile API gap endpoints (#321 §1):
// message search, reactions & attachments, thread history pagination,
// Coordinator proactive cards & suggestions, profile & avatar editing, and billing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock, test } from 'node:test'
import { ActionFailureError } from '../lib/action-error'
import { ChatFileError } from '../lib/chat-attachments/extract'
import { GovernanceError } from '../lib/governance/errors'
import { MobileAvatarError } from '../lib/mobile-profile-contract'
import { WorkspaceError } from '../lib/workspace-error'

const WS_1 = '11111111-1111-4111-8111-111111111111'
const MSG_1 = '22222222-2222-4222-8222-222222222222'
const ATT_1 = '33333333-3333-4333-8333-333333333333'
const RUN_1 = '44444444-4444-4444-8444-444444444444'
const SUG_1 = '55555555-5555-4555-8555-555555555555'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

type FakeUser = { id: string; name: string; email: string; image: string | null }
type FakeSession = { user: FakeUser; session: { id: string }; tokenId?: string; tokenWorkspaceId?: string }

let signedInUser: FakeUser | null = { id: 'user-1', name: 'Alex', email: 'alex@example.com', image: null }
let currentSession: FakeSession | null = { user: signedInUser, session: { id: 'sess-1' } }
let originOk = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, {
  namedExports: {
    json,
    mobileUser: async () => signedInUser,
    writeAllowed: () => originOk,
    unauthorized: () => json({ error: 'authRequired' }, 401),
    forbiddenOrigin: () => json({ error: 'originNotAllowed' }, 403),
  },
})

mock.module(new URL('../lib/api-auth.ts', import.meta.url).href, {
  namedExports: {
    auth: { api: { getSession: async () => currentSession } },
    apiWorkspaceAllowed: (session: FakeSession, workspaceId: string) =>
      !session.tokenWorkspaceId || session.tokenWorkspaceId === workspaceId,
  },
})

mock.module(new URL('../lib/request-log.ts', import.meta.url).href, {
  namedExports: {
    withRequestLog: (_: string, handler: unknown) => handler,
    noteLogUser: () => {},
    noteLogRpcAction: () => {},
  },
})

mock.module(new URL('../lib/fresh-session.ts', import.meta.url).href, {
  namedExports: {
    freshSessionRoute: (handler: unknown) => handler,
    withFreshSession: (fn: () => unknown) => fn(),
  },
})

mock.module(new URL('../lib/background.ts', import.meta.url).href, {
  namedExports: { afterJob: (_name: string, _fn: () => unknown) => {} },
})

let workspaceError: WorkspaceError | null = null
mock.module(new URL('../lib/workspace-access.ts', import.meta.url).href, {
  namedExports: {
    WorkspaceError,
    loadWorkspaceContext: async () => {
      if (workspaceError) throw workspaceError
      return { workspace: { id: WS_1, name: 'Personal', kind: 'personal' }, role: 'admin', choices: [] }
    },
  },
})

// Gap 1 mocks
class FakeSearchAccessError extends Error {}
let searchResult: unknown = {
  workspaceId: WS_1,
  query: 'hello',
  items: [{ kind: 'bot', messageId: MSG_1, targetId: WS_1, title: 'Coordinator', snippet: 'hello world', authorType: 'bot', position: '1', createdAt: '2026-11-24T12:00:00.000000Z' }],
  nextCursor: null,
}
let searchThrows: Error | null = null
mock.module(new URL('../lib/mobile-message-search.ts', import.meta.url).href, {
  namedExports: {
    MobileMessageSearchAccessError: FakeSearchAccessError,
    searchMobileMessages: async () => {
      if (searchThrows) throw searchThrows
      return searchResult
    },
  },
})

// Gap 2 mocks (reactions & attachments)
let outsideMsgIds = new Set<string>()
let outsideRunIds = new Set<string>()
let outsideSuggestionIds = new Set<string>()
mock.module(new URL('../lib/tokens/scope.ts', import.meta.url).href, {
  namedExports: {
    messagesOutsideToken: async (_user: unknown, ids: readonly string[]) =>
      new Set(ids.filter(id => outsideMsgIds.has(id))),
    runOutsideToken: async (_user: unknown, id: string) => outsideRunIds.has(id),
    suggestionsOutsideToken: async (_user: unknown, ids: readonly string[]) =>
      new Set(ids.filter(id => outsideSuggestionIds.has(id))),
  },
})

let reactionSetOk = true
let reactionMap: Record<string, { emoji: string; count: number; mine: boolean }[]> = {
  [MSG_1]: [{ emoji: '👍', count: 1, mine: true }],
}
mock.module(new URL('../lib/reactions.ts', import.meta.url).href, {
  namedExports: {
    REACTIONS: ['❤️', '👍', '👎', '😂', '🎉', '🙏'] as const,
    setReaction: async () => reactionSetOk,
    visibleReactableMessages: async (_userId: string, ids: readonly string[]) => [...ids],
    reactionsFor: async () => reactionMap,
  },
})

let attachmentsResult: unknown[] = [
  { id: ATT_1, name: 'spec.pdf', mediaType: 'application/pdf', size: 1024, scope: { kind: 'bot', id: WS_1 }, createdAt: '2026-11-24T12:00:00Z', downloadPath: `/api/chat/attachments/${ATT_1}`, downloadUrl: null },
]
let attachmentsThrows: Error | null = null
mock.module(new URL('../lib/mobile-attachments.ts', import.meta.url).href, {
  namedExports: {
    readMobileAttachments: async () => {
      if (attachmentsThrows) throw attachmentsThrows
      return attachmentsResult
    },
  },
})

// Gap 3 mocks (thread pagination route)
const fakeThreadItems = [
  { kind: 'person', id: 'p-1', text: 'first', author: 'Alex', mine: true, at: 1 },
  { kind: 'agent', id: `text:${RUN_1}:a1`, text: 'second', at: 2 },
  { kind: 'person', id: 'p-2', text: 'third', author: 'Alex', mine: true, at: 3 },
  { kind: 'agent', id: `text:${RUN_1}:a2`, text: 'fourth', at: 4 },
]
mock.module(new URL('../lib/db/index.ts', import.meta.url).href, {
  namedExports: {
    db: {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: async () => [{ runId: RUN_1, seq: 1, chunk: { type: 'text', text: 'x' }, at: new Date() }],
            }),
          }),
        }),
      }),
    },
    pool: { query: async () => ({ rows: [{ selectedModel: 'gpt-6-luna', servedModel: 'gpt-6-luna' }] }) },
  },
})
mock.module(new URL('../lib/workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: {} } })
mock.module(new URL('../lib/context-usage.ts', import.meta.url).href, { namedExports: { threadModelProjection: 'NULL, NULL' } })
mock.module(new URL('../lib/thread-reads.ts', import.meta.url).href, { namedExports: { threadReadReceipts: async () => [] } })
mock.module(new URL('../lib/agent-runs.ts', import.meta.url).href, {
  namedExports: {
    readRun: async () => ({ run: { id: RUN_1, agentId: 'a-1', issueId: null, status: 'succeeded', report: null, error: null }, messages: [] }),
    readRunMessages: async () => [],
  },
})
mock.module(new URL('../lib/run-chain.ts', import.meta.url).href, { namedExports: { readRunChain: async () => null } })
mock.module(new URL('../lib/thread-continue.ts', import.meta.url).href, { namedExports: { sendThreadMessage: async () => ({ runId: RUN_1, continued: false }) } })
mock.module(new URL('../lib/issue-run-conversation.ts', import.meta.url).href, {
  namedExports: {
    chainChunks: (rows: unknown[]) => rows,
    runIsActive: () => false,
    runIsWorking: () => false,
    runSummaryView: () => ({}),
    threadItems: async () => fakeThreadItems,
  },
})
mock.module(new URL('../lib/mobile-threads.ts', import.meta.url).href, {
  namedExports: { mobileThread: async () => ({ id: RUN_1, name: 'Test thread', status: 'done' }) },
})
mock.module(new URL('../lib/run-quota-view.ts', import.meta.url).href, { namedExports: { threadQuotaView: async () => ({ paused: null }) } })
mock.module(new URL('../lib/live/panels.ts', import.meta.url).href, { namedExports: { threadLiveReferences: async () => [] } })

// Gap 4 mocks (proactive cards & suggestions)
const proactiveCalls: unknown[] = []
let proactiveError: Error | null = null
mock.module(new URL('../lib/mobile-proactive-cards.ts', import.meta.url).href, {
  namedExports: {
    readMobileProactiveCards: async (_user: unknown, opts: unknown) => {
      proactiveCalls.push(opts)
      if (proactiveError) throw proactiveError
      return {
        workspaceId: WS_1,
        observedAt: '2026-11-24T12:00:00.000Z',
        briefing: {
          localDate: '2026-11-24',
          kind: 'daily',
          total: 2,
          counts: { github: 2 },
          highlights: [SUG_1],
          createdAt: '2026-11-24T08:00:00.000Z',
        },
        pendingActions: [],
        suggestions: { inProgress: [], items: [] },
      }
    },
  },
})
let handoffError: Error | null = null
mock.module(new URL('../lib/suggestions/handoff.ts', import.meta.url).href, {
  namedExports: {
    handoffSuggestionToCoordinator: async () => {
      if (handoffError) throw handoffError
      return { queued: true as const }
    },
  },
})
let dismissResult = true
mock.module(new URL('../lib/suggestions/store.ts', import.meta.url).href, {
  namedExports: { dismissSuggestion: async () => dismissResult },
})
mock.module(new URL('../lib/cloud-computer/suggestions.ts', import.meta.url).href, {
  namedExports: {
    resolveSuggestionStartWorkspace: async () => {
      if (workspaceError) throw workspaceError
      return WS_1
    },
    startSuggestion: async () => ({ started: true, runId: RUN_1 }),
  },
})
mock.module(new URL('../lib/computer/store.ts', import.meta.url).href, {
  namedExports: {
    ComputerError: class ComputerError extends Error {
      constructor(message: string, readonly status = 400) {
        super(message)
      }
    },
  },
})
mock.module(new URL('../lib/coordinator/wake.ts', import.meta.url).href, {
  namedExports: { wakeCoordinator: async () => {} },
})
mock.module(new URL('../lib/governance/http.ts', import.meta.url).href, {
  namedExports: {
    governanceJson: async (request: Request) => {
      try {
        return JSON.parse(await request.text())
      } catch (cause) {
        throw new GovernanceError('invalid_request', cause)
      }
    },
  },
})
mock.module(new URL('../lib/workspace-admin/action.ts', import.meta.url).href, {
  namedExports: {
    isActionErrorCode: (code: string) =>
      ['workspaceAccessDenied', 'billingNoSubscription', 'billingPolicyChanged', 'billingNotConfigured'].includes(code),
  },
})

// Gap 5 mocks (profile & avatar)
class FakeProfileSessionError extends Error {
  constructor(readonly code: 'authRequired' | 'sessionRequired', readonly status: 401 | 403) {
    super(code)
  }
}
let avatarError: Error | null = null
mock.module(new URL('../lib/mobile-profile.ts', import.meta.url).href, {
  namedExports: {
    MobileProfileSessionError: FakeProfileSessionError,
    requireMobileHumanSession: async () => {
      if (!currentSession) throw new FakeProfileSessionError('authRequired', 401)
      if (currentSession.tokenId) throw new FakeProfileSessionError('sessionRequired', 403)
      return currentSession
    },
    readMobileProfile: async () => signedInUser,
    updateMobileProfileName: async (_req: Request, _userId: string, name: string) => ({
      user: signedInUser ? { ...signedInUser, name } : null,
      setCookies: ['mikka.session_data=refreshed; Path=/; HttpOnly'],
    }),
    updateMobileProfileAvatar: async () => {
      if (avatarError) throw avatarError
      const image = `/api/avatars/user-1/${'a'.repeat(64)}`
      return {
        image,
        user: signedInUser ? { ...signedInUser, image } : null,
        setCookies: ['mikka.session_data=refreshed-avatar; Path=/; HttpOnly'],
      }
    },
  },
})

// Gap 6 mocks (billing)
let billingReadResult: unknown = { available: true, billingScope: { kind: 'workspace', id: WS_1 }, view: { scope: { kind: 'workspace', id: WS_1, name: 'Personal' } } }
let billingReadError: Error | null = null
let billingMutateResult: unknown = { url: 'https://billing.stripe.com/session/123' }
let billingMutateError: Error | null = null
mock.module(new URL('../lib/mobile-billing.ts', import.meta.url).href, {
  namedExports: {
    readMobileBilling: async () => {
      if (billingReadError) throw billingReadError
      return billingReadResult
    },
    runMobileBillingMutation: async () => {
      if (billingMutateError) throw billingMutateError
      return billingMutateResult
    },
  },
})

const searchRoute = import('../app/api/mobile/search/messages/route')
const reactionsRoute = import('../app/api/mobile/reactions/route')
const attachmentsRoute = import('../app/api/mobile/attachments/route')
const threadRoute = import('../app/api/mobile/threads/[id]/route')
const proactiveRoute = import('../app/api/mobile/proactive-cards/route')
const suggestionRoute = import('../app/api/mobile/suggestions/[id]/route')
const profileRoute = import('../app/api/mobile/profile/route')
const avatarRoute = import('../app/api/mobile/profile/avatar/route')
const billingRoute = import('../app/api/mobile/billing/route')

function resetAuth() {
  signedInUser = { id: 'user-1', name: 'Alex', email: 'alex@example.com', image: null }
  currentSession = { user: signedInUser, session: { id: 'sess-1' } }
  originOk = true
  workspaceError = null
  proactiveError = null
  outsideMsgIds = new Set()
  outsideRunIds = new Set()
  outsideSuggestionIds = new Set()
  searchThrows = null
  attachmentsThrows = null
  handoffError = null
  avatarError = null
  billingReadError = null
  billingMutateError = null
}

test('Gap 1 route: GET /api/mobile/search/messages enforces auth, validation, workspace ACL and returns hits', async () => {
  resetAuth()
  const { GET } = await searchRoute

  const ok = await GET(new Request(`https://mikka.test/api/mobile/search/messages?q=hello&workspaceId=${WS_1}`))
  assert.equal(ok.status, 200)
  assert.equal(((await ok.json()) as { items: unknown[] }).items.length, 1)

  const short = await GET(new Request('https://mikka.test/api/mobile/search/messages?q=a'))
  assert.equal(short.status, 400)
  assert.equal(((await short.json()) as { error: string }).error, 'searchQueryTooShort')

  searchThrows = new FakeSearchAccessError('denied')
  const denied = await GET(new Request(`https://mikka.test/api/mobile/search/messages?q=hello&workspaceId=${WS_1}`))
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as { error: string }).error, 'searchAccessDenied')
  searchThrows = null

  signedInUser = null
  assert.equal((await GET(new Request('https://mikka.test/api/mobile/search/messages?q=hello'))).status, 401)

  // Regression guard (#137): mikkaSuperseded holds a revision UUID string, never cast to ::boolean in SQL.
  const searchStoreSource = readFileSync(new URL('../lib/mobile-message-search.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(searchStoreSource, /mikkaSuperseded'\)::boolean|mikkaRetried'\)::boolean/)
  assert.match(searchStoreSource, /COALESCE\(m\.message->'mikkaSuperseded', 'null'::jsonb\) IN \('null'::jsonb, 'false'::jsonb, '""'::jsonb\)/)
  assert.match(searchStoreSource, /COALESCE\(m\.message->'mikkaRetried', 'false'::jsonb\) IS DISTINCT FROM 'true'::jsonb/)
})

test('Gap 2 routes: reactions return updated counts and attachments enforce scope/auth', async () => {
  resetAuth()
  const reactions = await reactionsRoute
  const attachments = await attachmentsRoute

  const postRes = await reactions.POST(
    new Request('https://mikka.test/api/mobile/reactions', {
      method: 'POST',
      body: JSON.stringify({ messageId: MSG_1, emoji: '👍' }),
    }),
  )
  assert.equal(postRes.status, 200)
  assert.deepEqual(await postRes.json(), {
    ok: true,
    messageId: MSG_1,
    reactions: [{ emoji: '👍', count: 1, mine: true }],
  })

  // PAT out-of-scope message gets 404.
  outsideMsgIds = new Set([MSG_1])
  const blockedPost = await reactions.POST(
    new Request('https://mikka.test/api/mobile/reactions', {
      method: 'POST',
      body: JSON.stringify({ messageId: MSG_1, emoji: '👍' }),
    }),
  )
  assert.equal(blockedPost.status, 404)
  outsideMsgIds = new Set()

  // GET /api/mobile/reactions works across group & bot message IDs.
  const getReact = await reactions.GET(new Request(`https://mikka.test/api/mobile/reactions?ids=${MSG_1}`))
  assert.equal(getReact.status, 200)
  assert.deepEqual(await getReact.json(), { reactions: reactionMap })

  // GET /api/mobile/attachments works by ids and rejects malformed queries.
  const attOk = await attachments.GET(new Request(`https://mikka.test/api/mobile/attachments?ids=${ATT_1}`))
  assert.equal(attOk.status, 200)
  assert.equal(((await attOk.json()) as { attachments: unknown[] }).attachments.length, 1)

  const attBad = await attachments.GET(new Request('https://mikka.test/api/mobile/attachments'))
  assert.equal(attBad.status, 400)

  attachmentsThrows = new ChatFileError('notFound')
  const attNotFound = await attachments.GET(
    new Request(`https://mikka.test/api/mobile/attachments?scope=bot&id=${WS_1}`),
  )
  assert.equal(attNotFound.status, 404)
})

test('Gap 3 route: GET /api/mobile/threads/:id supports legacy unpaged reads and cursor pagination', async () => {
  resetAuth()
  const { GET } = await threadRoute
  const params = Promise.resolve({ id: RUN_1 })

  // Unpaged legacy request returns all 4 items.
  const full = await GET(new Request(`https://mikka.test/api/mobile/threads/${RUN_1}`), { params })
  assert.equal(full.status, 200)
  const fullBody = (await full.json()) as { items: { id: string }[]; hasMore: boolean; historyBefore: string | null; totalItems: number }
  assert.equal(fullBody.items.length, 4)
  assert.equal(fullBody.hasMore, false)
  assert.equal(fullBody.historyBefore, null)
  assert.equal(fullBody.totalItems, 4)

  // Paged request returns newest 2 items + historyBefore cursor.
  const page1 = await GET(new Request(`https://mikka.test/api/mobile/threads/${RUN_1}?limit=2`), { params })
  assert.equal(page1.status, 200)
  const body1 = (await page1.json()) as { items: { id: string }[]; hasMore: boolean; historyBefore: string | null; totalItems: number }
  assert.deepEqual(body1.items.map(i => i.id), ['p-2', `text:${RUN_1}:a2`])
  assert.equal(body1.hasMore, true)
  assert.ok(body1.historyBefore)

  // Next older page returns the first 2 items and terminates.
  const page2 = await GET(
    new Request(`https://mikka.test/api/mobile/threads/${RUN_1}?limit=2&before=${body1.historyBefore}`),
    { params },
  )
  assert.equal(page2.status, 200)
  const body2 = (await page2.json()) as { items: { id: string }[]; hasMore: boolean; historyBefore: string | null }
  assert.deepEqual(body2.items.map(i => i.id), ['p-1', `text:${RUN_1}:a1`])
  assert.equal(body2.hasMore, false)
  assert.equal(body2.historyBefore, null)

  // Bad window fails with 400 invalidWindow.
  const bad = await GET(new Request(`https://mikka.test/api/mobile/threads/${RUN_1}?limit=500`), { params })
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as { error: string }).error, 'invalidWindow')
})

test('Gap 4 routes: proactive cards read and suggestion handoff/start/dismiss obey mobile origin & token bounds', async () => {
  resetAuth()
  const proactive = await proactiveRoute
  const suggestions = await suggestionRoute

  proactiveCalls.length = 0
  const feed = await proactive.GET(new Request('https://mikka.test/api/mobile/proactive-cards?readonly=1&tz=America/New_York&locale=zh-CN'))
  assert.equal(feed.status, 200)
  const feedBody = (await feed.json()) as { briefing: Record<string, unknown> }
  assert.equal(feedBody.briefing.localDate, '2026-11-24')
  assert.equal('id' in feedBody.briefing, false)
  assert.deepEqual(proactiveCalls[0], {
    timeZone: 'America/New_York',
    ipTimeZone: null,
    locale: 'zh-CN',
    readonly: true,
  })

  // Regression guard (#137): WorkspaceError maps to 403/409 instead of unhandled 500.
  proactiveError = new WorkspaceError('workspaceAccessDenied')
  const feedDenied = await proactive.GET(new Request('https://mikka.test/api/mobile/proactive-cards'))
  assert.equal(feedDenied.status, 403)
  assert.deepEqual(await feedDenied.json(), { error: 'workspaceAccessDenied' })
  proactiveError = new WorkspaceError('workspaceSuspended')
  const feedSuspended = await proactive.GET(new Request('https://mikka.test/api/mobile/proactive-cards'))
  assert.equal(feedSuspended.status, 409)
  assert.deepEqual(await feedSuspended.json(), { error: 'workspaceSuspended' })
  proactiveError = null

  // Regression guard (#137): lib/mobile-proactive-cards.ts never references non-existent briefingRow.id.
  const proactiveSource = readFileSync(new URL('../lib/mobile-proactive-cards.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(proactiveSource, /briefingRow\.id/)

  const sendOk = await suggestions.POST(
    new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'send' }),
    }),
    { params: Promise.resolve({ id: SUG_1 }) },
  )
  assert.equal(sendOk.status, 202)
  assert.deepEqual(await sendOk.json(), { queued: true })

  const startOk = await suggestions.POST(
    new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    }),
    { params: Promise.resolve({ id: SUG_1 }) },
  )
  assert.equal(startOk.status, 202)
  assert.deepEqual(await startOk.json(), { started: true, runId: RUN_1 })

  // Regression guard (#137): WorkspaceError on suggestion start maps to 403/409, never 500.
  workspaceError = new WorkspaceError('workspaceAccessDenied')
  const startDenied = await suggestions.POST(
    new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    }),
    { params: Promise.resolve({ id: SUG_1 }) },
  )
  assert.equal(startDenied.status, 403)
  assert.deepEqual(await startDenied.json(), { error: 'workspaceAccessDenied' })
  workspaceError = null

  handoffError = new ActionFailureError('submissionConflict')
  const conflict = await suggestions.POST(
    new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'send' }),
    }),
    { params: Promise.resolve({ id: SUG_1 }) },
  )
  assert.equal(conflict.status, 409)
  handoffError = null

  dismissResult = true
  const delOk = await suggestions.DELETE(
    new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: SUG_1 }) },
  )
  assert.equal(delOk.status, 200)
  assert.deepEqual(await delOk.json(), { dismissed: true })

  // PAT out-of-scope suggestion is 404.
  outsideSuggestionIds = new Set([SUG_1])
  assert.equal(
    (
      await suggestions.DELETE(
        new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id: SUG_1 }) },
      )
    ).status,
    404,
  )
  outsideSuggestionIds = new Set()

  // Forbidden origin is 403.
  originOk = false
  assert.equal(
    (
      await suggestions.POST(
        new Request(`https://mikka.test/api/mobile/suggestions/${SUG_1}`, {
          method: 'POST',
          body: JSON.stringify({ action: 'send' }),
        }),
        { params: Promise.resolve({ id: SUG_1 }) },
      )
    ).status,
    403,
  )
})

test('Gap 5 routes: profile read/edit and avatar upload enforce human session, origin, and size/type checks', async () => {
  resetAuth()
  const profile = await profileRoute
  const avatar = await avatarRoute

  const got = await profile.GET(new Request('https://mikka.test/api/mobile/profile'))
  assert.equal(got.status, 200)
  assert.equal(((await got.json()) as { user: FakeUser }).user.name, 'Alex')

  const patched = await profile.PATCH(
    new Request('https://mikka.test/api/mobile/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Alex Updated' }),
    }),
  )
  assert.equal(patched.status, 200)
  assert.match(patched.headers.get('set-cookie') ?? '', /mikka\.session_data=refreshed/)
  assert.equal(((await patched.json()) as { user: FakeUser }).user.name, 'Alex Updated')

  const badName = await profile.PATCH(
    new Request('https://mikka.test/api/mobile/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name: '   ' }),
    }),
  )
  assert.equal(badName.status, 400)
  assert.equal(((await badName.json()) as { error: string }).error, 'validationNameRequired')

  // PAT cannot mutate account-wide profile or avatar.
  currentSession = { user: signedInUser!, session: { id: 'pat:1' }, tokenId: 'tok-1', tokenWorkspaceId: WS_1 }
  const patPatch = await profile.PATCH(
    new Request('https://mikka.test/api/mobile/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Blocked' }),
    }),
  )
  assert.equal(patPatch.status, 403)
  assert.equal(((await patPatch.json()) as { error: string }).error, 'sessionRequired')

  const patAvatar = await avatar.POST(
    new Request('https://mikka.test/api/mobile/profile/avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG_BYTES,
    }),
  )
  assert.equal(patAvatar.status, 403)
  resetAuth()

  // Avatar upload succeeds for human session and maps MobileAvatarError cleanly.
  const uploaded = await avatar.POST(
    new Request('https://mikka.test/api/mobile/profile/avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG_BYTES,
    }),
  )
  assert.equal(uploaded.status, 200)
  assert.match(uploaded.headers.get('set-cookie') ?? '', /mikka\.session_data=refreshed-avatar/)
  assert.ok(((await uploaded.json()) as { image: string }).image.startsWith('/api/avatars/user-1/'))

  avatarError = new MobileAvatarError('avatarInvalidType', 400)
  const invalidBytes = await avatar.POST(
    new Request('https://mikka.test/api/mobile/profile/avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG_BYTES,
    }),
  )
  assert.equal(invalidBytes.status, 400)
  avatarError = null

  originOk = false
  assert.equal(
    (
      await profile.PATCH(
        new Request('https://mikka.test/api/mobile/profile', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Blocked' }),
        }),
      )
    ).status,
    403,
  )
})

test('Gap 6 route: GET/POST /api/mobile/billing handles admin/non-admin views, actions, origin and governance errors', async () => {
  resetAuth()
  const { GET, POST } = await billingRoute

  const readOk = await GET(new Request('https://mikka.test/api/mobile/billing'))
  assert.equal(readOk.status, 200)
  assert.equal(((await readOk.json()) as { available: boolean }).available, true)

  billingReadResult = { available: false, billingScope: null, view: null }
  const nonAdmin = await GET(new Request('https://mikka.test/api/mobile/billing'))
  assert.equal(nonAdmin.status, 200)
  assert.deepEqual(await nonAdmin.json(), { available: false, billingScope: null, view: null })

  const badScope = await GET(new Request('https://mikka.test/api/mobile/billing?scopeKind=workspace'))
  assert.equal(badScope.status, 400)

  const postOk = await POST(
    new Request('https://mikka.test/api/mobile/billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'portal', accountWorkspaceId: WS_1 }),
    }),
  )
  assert.equal(postOk.status, 200)
  assert.deepEqual(await postOk.json(), { url: 'https://billing.stripe.com/session/123' })

  const nonJson = await POST(
    new Request('https://mikka.test/api/mobile/billing', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'portal',
    }),
  )
  assert.equal(nonJson.status, 400)

  billingMutateError = new GovernanceError('plan_changed')
  const conflict = await POST(
    new Request('https://mikka.test/api/mobile/billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'portal', accountWorkspaceId: WS_1 }),
    }),
  )
  assert.equal(conflict.status, 409)
  assert.equal(((await conflict.json()) as { error: string }).error, 'billingPolicyChanged')
  billingMutateError = null

  billingMutateError = new WorkspaceError('workspaceAccessDenied')
  const denied = await POST(
    new Request('https://mikka.test/api/mobile/billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'portal', accountWorkspaceId: WS_1 }),
    }),
  )
  assert.equal(denied.status, 403)
  billingMutateError = null

  originOk = false
  assert.equal(
    (
      await POST(
        new Request('https://mikka.test/api/mobile/billing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'portal', accountWorkspaceId: WS_1 }),
        }),
      )
    ).status,
    403,
  )

  originOk = true
  currentSession = null
  assert.equal((await GET(new Request('https://mikka.test/api/mobile/billing'))).status, 401)
  assert.equal(
    (
      await POST(
        new Request('https://mikka.test/api/mobile/billing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'portal', accountWorkspaceId: WS_1 }),
        }),
      )
    ).status,
    401,
  )
})
