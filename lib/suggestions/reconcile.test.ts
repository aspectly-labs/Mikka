import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The hourly backfill against stubbed Composio and storage: one person's revoked
// provider token must not fail the run or stop the people after them.
const NOTION_401 = '{"object":"error","status":401,"code":"unauthorized","message":"API token is invalid.","additional_data":{"reason":"token_invalid"}}'
const people = ['person-revoked', 'person-ok']
// A person whose connected-apps read never answers (a stalled provider call or database connection).
const stalled = new Set<string>()
const limits: unknown[] = []
const peopleRows = () => Object.assign(Promise.resolve(people.map(userId => ({ userId }))), {
  limit: async (count: number) => { limits.push(count); return people.map(userId => ({ userId })) },
})
let failure: (userId: string) => string | null = () => null
const ingested: unknown[][] = []
const marked: unknown[][] = []
const cleared: unknown[][] = []
const notionCalls: { userId: string; input: { page_size?: number; start_cursor?: string } }[] = []
const stamps: { reconciledAt: unknown }[] = []
const notionPages: Record<string, number> = {}
// Which page a person's failure lands on (default 1 = the read fails outright).
const failAfter: Record<string, number> = {}
const page = (id: string) => ({ object: 'page', id, url: `https://www.notion.so/${id}`, last_edited_time: new Date().toISOString(), properties: { title: { type: 'title', title: [{ plain_text: 'Plan' }] } } })

let reconcile: typeof import('./reconcile')
before(async () => {
  mock.module('./github-redelivery', { namedExports: { redeliverFailedGitHubWebhooks: async () => null } })
  mock.module('./sources', { namedExports: { ensureComposioTriggers: async () => undefined, linearWebhookNotifications: async () => [] } })
  mock.module('./store', { namedExports: { ingestNotifications: async (notifications: unknown[]) => { ingested.push(notifications) } } })
  mock.module('@/lib/composio-account-store', { namedExports: {
    markComposioNeedsReconnect: async (...args: unknown[]) => { marked.push(args) },
    clearComposioNeedsReconnect: async (...args: unknown[]) => { cleared.push(args) },
  } })
  // Two selects: the people to backfill, then (per person with pages) the suggestions already on file.
  mock.module('@/lib/db', { namedExports: { db: { select: () => ({ from: () => ({
    orderBy: peopleRows,
    // where() must stay awaitable rows for the already-on-file read while still chaining orderBy for the people query.
    where: () => Object.assign(Promise.resolve([]), { orderBy: peopleRows }),
  }) }),
    update: () => ({ set: (value: unknown) => { stamps.push(value as { reconciledAt: unknown }); return { where: async () => [] } } }),
  }, pool: null } })
  mock.module('@/lib/composio', { namedExports: {
    getComposio: () => ({ connectedAccounts: { list: async ({ userIds }: { userIds: string[] }) => stalled.has(userIds[0]) ? new Promise(() => {}) : ({ items: [{ id: `acct-${userIds[0]}`, status: 'ACTIVE', isDisabled: false, toolkit: { slug: 'notion' } }], nextCursor: null }) } }),
    runComposioAction: async (userId: string, action?: string, input?: { page_size?: number; start_cursor?: string }) => {
      const error = failure(userId)
      if (action === 'list_recent_notion_pages') {
        notionCalls.push({ userId, input: input ?? {} })
        const seen = (notionPages[userId] = (notionPages[userId] ?? 0) + 1)
        if (error && seen >= (failAfter[userId] ?? 1)) return { error, accountId: `acct-${userId}` }
        // The first answer says more pages exist; the follow-up must carry its cursor.
        return seen === 1
          ? { data: { results: [page(`${userId}-page`)], has_more: true, next_cursor: 'cursor-2' }, accountId: `acct-${userId}` }
          : { data: { results: [page(`${userId}-page2`)], has_more: false }, accountId: `acct-${userId}` }
      }
      if (error) return { error, accountId: `acct-${userId}` }
      return { data: { results: [] }, accountId: `acct-${userId}` }
    },
  } })
  reconcile = await import('./reconcile')
})
beforeEach(() => {
  ingested.length = 0; marked.length = 0; cleared.length = 0; notionCalls.length = 0; stamps.length = 0; limits.length = 0
  stalled.clear()
  for (const key of Object.keys(notionPages)) delete notionPages[key]
  for (const key of Object.keys(failAfter)) delete failAfter[key]
  failure = () => null
})

test('a revoked provider token skips that person as needing reconnecting; the run goes on and does not fail', async () => {
  failure = userId => userId === 'person-revoked' ? NOTION_401 : null
  const warnings = mock.method(console, 'warn', () => {})
  const errors = mock.method(console, 'error', () => {})
  try {
    const result = await reconcile.reconcileSuggestions()
    assert.equal(result.people, 2)
    assert.deepEqual(result.failed, {}, 'not a failed run')
    assert.deepEqual(result.reconnect, { notion: 1 })
    assert.equal(result.read.notion, 2, 'the next person is still read, both pages')
    assert.equal(errors.mock.callCount(), 0)
    assert.equal(stamps.length, 2, 'both people were stamped')
    assert.ok(stamps.every(value => value.reconciledAt instanceof Date), 'clean passes stamp the reconcile time')
    // The refused account is marked for the person to reconnect; the one that read fine is cleared.
    assert.deepEqual(marked, [['person-revoked', 'notion', 'acct-person-revoked']])
    assert.deepEqual(cleared, [['person-ok', 'acct-person-ok']])
    // The provider's answer concerns the person's credentials and is not logged.
    assert.ok(warnings.mock.calls.every(call => !JSON.stringify(call.arguments).includes('API token is invalid')))
  } finally { warnings.mock.restore(); errors.mock.restore() }
})

test('any other provider failure is still a failed read', async () => {
  failure = userId => userId === 'person-revoked' ? '{"object":"error","status":502,"code":"service_unavailable"}' : null
  const errors = mock.method(console, 'error', () => {})
  try {
    const result = await reconcile.reconcileSuggestions()
    assert.deepEqual(result.failed, { notion: 1 })
    assert.deepEqual(result.reconnect, {})
    assert.equal(result.read.notion, 2)
    assert.deepEqual(marked, [], 'a provider outage is not the person\'s to reconnect')
    assert.ok(stamps.some(value => value.reconciledAt === null), 'the failed pass stays due')
    assert.ok(stamps.some(value => value.reconciledAt instanceof Date), 'the clean pass is stamped')
  } finally { errors.mock.restore() }
})

test('a failed later Notion page keeps the fetched pages and stays due', async () => {
  failAfter['person-revoked'] = 2
  failure = userId => userId === 'person-revoked' ? '{"status":502}' : null
  const errors = mock.method(console, 'error', () => {})
  try {
    const result = await reconcile.reconcileSuggestions()
    assert.equal(result.failed.notion, 1, 'the broken tail counts as a failed read')
    assert.ok(ingested.some(notifications => notifications.length > 0), 'the first page\'s edits were ingested')
    assert.ok(stamps.some(value => value.reconciledAt === null), 'the partial pass stays due')
    assert.ok(stamps.some(value => value.reconciledAt instanceof Date), 'the clean pass is stamped')
    assert.ok(errors.mock.calls.every(call => !JSON.stringify(call.arguments).includes('502')), 'only the error name is logged')
  } finally { errors.mock.restore() }
})

test('the Notion read follows the cursor its first answer gave', async () => {
  await reconcile.reconcileSuggestions()
  const okCalls = notionCalls.filter(call => call.userId === 'person-ok')
  assert.equal(okCalls.length, 2, 'has_more keeps the read going')
  assert.equal(okCalls[1].input.start_cursor, 'cursor-2')
})

test('one run reads a bounded number of people, least recently checked first', async () => {
  const result = await reconcile.reconcileSuggestions()
  assert.deepEqual(limits, [reconcile.PEOPLE_PER_RUN], 'the people read carries a LIMIT')
  assert.ok(reconcile.PEOPLE_PER_RUN > 0 && reconcile.PEOPLE_PER_RUN <= 200)
  assert.equal(result.overran, undefined)
})

test('a pass that never answers does not hold the run past its deadline', async () => {
  stalled.add('person-revoked')
  const warnings = mock.method(console, 'warn', () => {})
  try {
    const started = Date.now()
    const result = await reconcile.reconcileSuggestions({ deadline: started + 200 })
    assert.ok(Date.now() - started < 2_000, 'the run answers at its deadline')
    assert.equal(result.overran, 1, 'the stalled pass is reported')
    assert.equal(result.deferred, 1, 'and left for the next run')
    assert.equal(result.people, 1, 'the other person in the batch still finished')
    assert.equal(stamps.length, 1, 'only the finished pass was stamped')
    assert.deepEqual(result.failed, {}, 'stopping at the deadline is not a failed read')
  } finally { warnings.mock.restore() }
})

test('needsReconnect recognises refused authorization only', () => {
  for (const message of [NOTION_401, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', 'Request failed with status code 401: Unauthorized', 'invalid_token'])
    assert.equal(reconcile.needsReconnect(message), true, message)
  for (const message of ['{"status":500,"code":"internal_server_error"}', 'fetch failed', 'integrationActionFailed', 'rate_limited', '{"status":429}'])
    assert.equal(reconcile.needsReconnect(message), false, message)
})
