import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { before, beforeEach, mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import { planMigration } from '../scripts/migration-steps.mjs'
import { tokenWorkspace } from './tokens/principal'

const OWNER = 'perf-owner'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const ROOT_RUN = '22222222-2222-4222-8222-222222222222'
const MSG_ID = '33333333-3333-4333-8333-333333333333'
const DEVICE_ID = '44444444-4444-4444-8444-444444444444'
const TASK_1 = '66666666-6666-4666-8666-666666666666'
const TASK_2 = '77777777-7777-4777-8777-777777777777'
const CHAT_1 = '88888888-8888-4888-8888-888888888888'
const MATTER_1 = '99999999-9999-4999-8999-999999999999'
const MATTER_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MATTER_3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface LoggedSql {
  via: 'pool' | 'client' | 'tx'
  sql: string
  params: unknown[]
}

let sqlLog: LoggedSql[] = []
let failChunkCopy = false
let existingByDispatchKey = new Map<string, Record<string, unknown>>()
let notifiedDevices: string[] = []
let liveInvalidations: string[] = []
let citationCalls: Array<{ userId: string; citations: string[] }> = []
let conversationQueryCalls: Array<{ chatIds: string[]; userId: string; workspaceId: string }> = []
let authSession: { user: { id: string; [tokenWorkspace]?: string } } | null = null
let attentionOpenRows: Array<{ id: string; userId: string; title: string; level: 'high' | 'medium' | 'low'; state: 'handed'; reason: string | null; personAsked: boolean; recheck: boolean; updatedAt: Date }> = []

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const mockClientPool = {
  async query(sqlText: string, params: unknown[] = []) {
    const q = compact(sqlText)
    sqlLog.push({ via: 'pool', sql: q, params })
    if (q.startsWith('SELECT * FROM agent_runs WHERE id=$1')) {
      return {
        rows: [{
          id: ROOT_RUN, userId: OWNER, workspaceId: WORKSPACE, deviceId: DEVICE_ID,
          title: 'Source thread', prompt: 'Initial prompt', status: 'succeeded', deletedAt: null,
        }],
      }
    }
    if (q.includes('SELECT text FROM run_messages')) {
      return { rows: [{ text: 'follow up' }] }
    }
    if (q.includes('SELECT id,"createdAt"::text AS at FROM run_messages')) {
      return { rows: [{ id: MSG_ID, at: '2026-11-24T10:00:00.000Z' }] }
    }
    if (q.includes('SELECT c.id, c.title FROM conversations c')) {
      conversationQueryCalls.push({
        chatIds: params[0] as string[],
        userId: String(params[1]),
        workspaceId: String(params[2]),
      })
      return { rows: [{ id: CHAT_1, title: 'Release Group' }] }
    }
    if (q.includes('SELECT m.id, r."userId", r."workspaceId" FROM run_messages m')) {
      const ids = params[0] as string[]
      return { rows: ids.map(id => ({ id, userId: OWNER, workspaceId: WORKSPACE })) }
    }
    return { rows: [] }
  },
  async connect() {
    let released = false
    const stagedRuns = new Map<string, Record<string, unknown>>()
    return {
      async query(sqlText: string, params: unknown[] = []) {
        const q = compact(sqlText)
        sqlLog.push({ via: 'client', sql: q, params })
        if (q === 'BEGIN') return { rows: [] }
        if (q === 'COMMIT') {
          for (const [k, v] of stagedRuns) existingByDispatchKey.set(k, v)
          return { rows: [] }
        }
        if (q === 'ROLLBACK') {
          stagedRuns.clear()
          return { rows: [] }
        }
        if (q.startsWith('INSERT INTO agent_runs')) {
          const dispatchKey = q.includes('"dispatchKey"') ? String(params[6]) : null
          const dispatchFingerprint = q.includes('"dispatchFingerprint"') ? String(params[7]) : null
          if (dispatchKey && existingByDispatchKey.has(dispatchKey)) {
            return { rows: [] }
          }
          const created = {
            id: String(params[0]),
            userId: OWNER,
            workspaceId: WORKSPACE,
            deviceId: DEVICE_ID,
            status: 'queued',
            prompt: String(params[2]),
            parentRunId: String(params[3]),
            threadRelation: String(params[4]),
            sourceMessageId: params[5] ?? null,
            dispatchKey,
            dispatchFingerprint,
          }
          if (dispatchKey) stagedRuns.set(dispatchKey, created)
          return { rows: [created] }
        }
        if (q.startsWith('SELECT * FROM agent_runs WHERE "userId"=$1 AND "dispatchKey"=$2')) {
          const hit = existingByDispatchKey.get(String(params[1]))
          return { rows: hit ? [hit] : [] }
        }
        if (q.includes('INSERT INTO run_chunks') && failChunkCopy) {
          throw new Error('simulated chunk copy failure')
        }
        return { rows: [] }
      },
      release() {
        released = true
      },
      get released() { return released },
    }
  },
}

let dbQueryHandler: ((sqlText: string, params: unknown[], rowMode?: string) => unknown[]) | null = null

const capturedDb = drizzle({
  client: {
    async query(queryConfig: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
      const text = typeof queryConfig === 'string' ? queryConfig : queryConfig.text
      const params = (typeof queryConfig === 'string' ? values : (queryConfig.values ?? values)) ?? []
      const rowMode = typeof queryConfig === 'string' ? undefined : queryConfig.rowMode
      const q = compact(text)
      sqlLog.push({ via: 'tx', sql: q, params })
      const rows = dbQueryHandler ? dbQueryHandler(q, params, rowMode) : []
      return { rows, rowCount: rows.length, command: 'SELECT', fields: [] }
    },
    async connect() {
      return {
        async query(queryConfig: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
          const text = typeof queryConfig === 'string' ? queryConfig : queryConfig.text
          const params = (typeof queryConfig === 'string' ? values : (queryConfig.values ?? values)) ?? []
          const rowMode = typeof queryConfig === 'string' ? undefined : queryConfig.rowMode
          const q = compact(text)
          sqlLog.push({ via: 'tx', sql: q, params })
          const rows = dbQueryHandler ? dbQueryHandler(q, params, rowMode) : []
          return { rows, rowCount: rows.length, command: 'SELECT', fields: [] }
        },
        release() {},
      }
    },
  } as never,
})

let lifecycle: typeof import('./thread-lifecycle')
let forkRoute: typeof import('../app/api/threads/[runId]/fork/route')
let sideRoute: typeof import('../app/api/threads/[runId]/side-threads/route')
let messageRefs: typeof import('./message-references')
let queryVersionMod: typeof import('./db/query-version')
let attentionStore: typeof import('./attention/store')

before(async () => {
  mock.module('./db/index.ts', {
    namedExports: {
      pool: mockClientPool,
      db: capturedDb,
      withDatabaseClient: async (_c: unknown, fn: () => unknown) => fn(),
      withDatabaseTransaction: async (_t: unknown, fn: () => unknown) => fn(),
    },
  })
  mock.module('./run-chain.ts', {
    namedExports: {
      readRunChain: async () => ({
        rootRunId: ROOT_RUN,
        latestRunId: ROOT_RUN,
        attempts: [{ runId: ROOT_RUN, attempt: 1, status: 'succeeded', stopRequestedAt: null, createdAt: new Date(), finishedAt: new Date() }],
      }),
    },
  })
  mock.module('./tokens/scope.ts', {
    namedExports: { runOutsideToken: async () => false },
  })
  mock.module('./live/lists.ts', {
    namedExports: {
      runListChanged: async (_db: unknown, id: string) => { liveInvalidations.push(`runList:${id}`) },
      ownerListChanged: async () => {},
      deviceCheckoutsChanged: async () => {},
      workspaceListChanged: async () => {},
    },
  })
  mock.module('./device-repositories.ts', {
    namedExports: {
      ensureDeviceRepository: async () => '',
    },
  })
  mock.module('./schedules/runtime.ts', {
    namedExports: {
      schedules: { wake: async () => {} },
    },
  })
  mock.module('./live/panels.ts', {
    namedExports: {
      runChanged: async (_db: unknown, id: string) => { liveInvalidations.push(`run:${id}`) },
      issueThreadsChanged: async (_db: unknown, id: string) => { liveInvalidations.push(`issueThreads:${id}`) },
    },
  })
  mock.module('./device-gateway-notify.ts', {
    namedExports: {
      notifyDeviceWork: (deviceId: string) => { notifiedDevices.push(deviceId) },
    },
  })
  mock.module('./api-auth.ts', {
    namedExports: {
      auth: { api: { getSession: async () => authSession } },
    },
  })
  mock.module('./coordinator/store.ts', {
    namedExports: {
      COORDINATOR_CONVERSATION_ROW_LIMIT: 500,
      citationSources: async (reader: { id: string }, citations: string[]) => {
        citationCalls.push({ userId: reader.id, citations })
        return {
          [TASK_1]: { kind: 'issue', title: 'Fix perf', identifier: 'MIK-1', status: 'in_progress' },
          [TASK_2]: { kind: 'issue', title: 'Add index', identifier: 'MIK-2', status: 'todo' },
        }
      },
    },
  })
  mock.module('./coordinator/citations.ts', {
    namedExports: { runTitle: (source: { title?: string }) => source.title ?? 'Thread' },
  })

  lifecycle = await import('./thread-lifecycle')
  forkRoute = await import('../app/api/threads/[runId]/fork/route')
  sideRoute = await import('../app/api/threads/[runId]/side-threads/route')
  messageRefs = await import('./message-references')
  queryVersionMod = await import('./db/query-version')
  attentionStore = await import('./attention/store')
})

beforeEach(() => {
  sqlLog = []
  failChunkCopy = false
  existingByDispatchKey = new Map()
  notifiedDevices = []
  liveInvalidations = []
  citationCalls = []
  conversationQueryCalls = []
  authSession = { user: { id: OWNER, [tokenWorkspace]: WORKSPACE } }
  attentionOpenRows = []
  dbQueryHandler = null
})

test('P0 #4: spawnThread runs insert + bounded message/chunk copy inside one transaction and rolls back cleanly on copy failure', async () => {
  const user = { id: OWNER, [tokenWorkspace]: WORKSPACE }
  const spawned = await lifecycle.spawnThread(user, ROOT_RUN, { relation: 'fork', mode: 'full' })
  assert.ok(spawned)

  const clientQueries = sqlLog.filter(entry => entry.via === 'client')
  assert.equal(clientQueries[0]?.sql, 'BEGIN')
  assert.match(clientQueries[1]!.sql, /^INSERT INTO agent_runs/)
  assert.match(clientQueries[2]!.sql, /INSERT INTO run_messages/)
  assert.match(clientQueries[2]!.sql, /ORDER BY "createdAt" DESC LIMIT \$4/)
  assert.equal(clientQueries[2]!.params[3], lifecycle.SPAWN_MESSAGE_COPY_LIMIT)
  assert.match(clientQueries[3]!.sql, /INSERT INTO run_chunks/)
  assert.match(clientQueries[3]!.sql, /ORDER BY "createdAt" DESC,seq DESC LIMIT \$4/)
  assert.equal(clientQueries[3]!.params[3], lifecycle.SPAWN_CHUNK_COPY_LIMIT)
  assert.equal(clientQueries[4]?.sql, 'COMMIT')
  assert.deepEqual(notifiedDevices, [DEVICE_ID])
  assert.equal(liveInvalidations.length, 2)

  // Copy failure must ROLLBACK and never wake the device or emit live invalidations.
  sqlLog = []
  notifiedDevices = []
  liveInvalidations = []
  failChunkCopy = true
  await assert.rejects(
    () => lifecycle.spawnThread(user, ROOT_RUN, { relation: 'fork', mode: 'full' }),
    /simulated chunk copy failure/,
  )
  const failedTx = sqlLog.filter(entry => entry.via === 'client').map(entry => entry.sql)
  assert.equal(failedTx[0], 'BEGIN')
  assert.equal(failedTx.at(-1), 'ROLLBACK')
  assert.ok(!failedTx.includes('COMMIT'))
  assert.deepEqual(notifiedDevices, [])
  assert.deepEqual(liveInvalidations, [])
})

test('P0 #4: spawnThread + /fork & /side-threads honor Idempotency-Key replays and reject mismatched conflicts with 409', async () => {
  const mkReq = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(url, {
      method: 'POST',
      headers: { origin: 'https://mikka.test', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  // First call creates the forked run.
  const firstRes = await forkRoute.POST(
    mkReq(`https://mikka.test/api/threads/${ROOT_RUN}/fork`, { mode: 'full' }, { 'idempotency-key': 'fork-key-1' }),
    { params: Promise.resolve({ runId: ROOT_RUN }) },
  )
  assert.equal(firstRes.status, 201)
  const firstBody = await firstRes.json() as { run: { id: string } }
  assert.equal(notifiedDevices.length, 1)

  // Exact replay returns the same run without re-copying chunks or re-waking the device.
  sqlLog = []
  notifiedDevices = []
  const replayRes = await forkRoute.POST(
    mkReq(`https://mikka.test/api/threads/${ROOT_RUN}/fork`, { mode: 'full' }, { 'idempotency-key': 'fork-key-1' }),
    { params: Promise.resolve({ runId: ROOT_RUN }) },
  )
  assert.equal(replayRes.status, 201)
  const replayBody = await replayRes.json() as { run: { id: string } }
  assert.equal(replayBody.run.id, firstBody.run.id)
  assert.equal(notifiedDevices.length, 0)
  assert.equal(sqlLog.filter(entry => entry.sql.includes('INSERT INTO run_chunks')).length, 0)

  // Reusing the same key with different mode returns 409 idempotencyKeyConflict.
  const conflictRes = await forkRoute.POST(
    mkReq(`https://mikka.test/api/threads/${ROOT_RUN}/fork`, { mode: 'summary' }, { 'idempotency-key': 'fork-key-1' }),
    { params: Promise.resolve({ runId: ROOT_RUN }) },
  )
  assert.equal(conflictRes.status, 409)
  assert.deepEqual(await conflictRes.json(), { error: 'idempotencyKeyConflict' })

  // Mismatched header and body idempotency keys return 400.
  const mismatchRes = await forkRoute.POST(
    mkReq(`https://mikka.test/api/threads/${ROOT_RUN}/fork`, { mode: 'full', idempotencyKey: 'key-a' }, { 'idempotency-key': 'key-b' }),
    { params: Promise.resolve({ runId: ROOT_RUN }) },
  )
  assert.equal(mismatchRes.status, 400)

  // Side-threads also honor Idempotency-Key replays and 409 conflicts.
  const sideFirst = await sideRoute.POST(
    mkReq(`https://mikka.test/api/threads/${ROOT_RUN}/side-threads`, { messageId: MSG_ID }, { 'idempotency-key': 'side-key-1' }),
    { params: Promise.resolve({ runId: ROOT_RUN }) },
  )
  assert.equal(sideFirst.status, 201)
  const sideConflict = await sideRoute.POST(
    mkReq(`https://mikka.test/api/threads/${ROOT_RUN}/side-threads`, { messageId: null }, { 'idempotency-key': 'side-key-1' }),
    { params: Promise.resolve({ runId: ROOT_RUN }) },
  )
  assert.equal(sideConflict.status, 409)
})

test('P1 N+1: resolveMessageReferencesBatch batches multiple messages into O(1) DB/citation queries', async () => {
  const texts = [
    `Check [[issue:${TASK_1}]] and [[chat:${CHAT_1}]]`,
    `Also [[issue:${TASK_2}]] and duplicate [[issue:${TASK_1}]]`,
    `And [[chat:${CHAT_1}]] plus https://github.com/aspectly-labs/Mikka/pull/3260`,
    'Plain text without references',
  ]
  const batch = await messageRefs.resolveMessageReferencesBatch({ userId: OWNER, workspaceId: WORKSPACE }, texts)
  assert.equal(batch.length, 4)
  assert.equal(conversationQueryCalls.length, 1, 'all chat refs must resolve in 1 SQL query')
  assert.deepEqual(conversationQueryCalls[0]!.chatIds, [CHAT_1])
  assert.equal(citationCalls.length, 1, 'all task/thread refs must resolve in 1 citationSources call')
  assert.deepEqual(citationCalls[0]!.citations.sort(), [`[[issue:${TASK_1}]]`, `[[issue:${TASK_2}]]`].sort())
  assert.equal(batch[0]![0]!.title, 'Fix perf')
  assert.equal(batch[0]![1]!.title, 'Release Group')
  assert.equal(batch[1]![0]!.identifier, 'MIK-2')
  assert.equal(batch[2]![1]!.type, 'pr')
  assert.deepEqual(batch[3], [])
})

test('P1 CTE dedup: queryVersionFromRowSignatures matches Postgres empty and sorted MD5 aggregation', () => {
  // Postgres md5('') for 0 rows
  assert.equal(queryVersionMod.queryVersionFromRowSignatures([]), 'd41d8cd98f00b204e9800998ecf8427e')
  const a = createHash('md5').update('row-a').digest('hex')
  const b = createHash('md5').update('row-b').digest('hex')
  const c = createHash('md5').update('row-c').digest('hex')
  const expected = createHash('md5').update([a, b, c].sort().join(',')).digest('hex')
  assert.equal(queryVersionMod.queryVersionFromRowSignatures([c, a, b]), expected)
  assert.equal(queryVersionMod.queryVersionFromRowSignatures([b, c, a]), expected)
})

test('P1 N+1: attentionStore.settleTurn batches updates & logs instead of issuing per-matter UPDATE loops', async () => {
  const now = new Date('2026-11-24T12:00:00.000Z')
  attentionOpenRows = [
    { id: MATTER_1, userId: OWNER, title: 'M1', level: 'medium', state: 'handed', reason: null, personAsked: false, recheck: false, updatedAt: now },
    { id: MATTER_2, userId: OWNER, title: 'M2', level: 'low', state: 'handed', reason: null, personAsked: true, recheck: false, updatedAt: now },
    { id: MATTER_3, userId: OWNER, title: 'M3', level: 'high', state: 'handed', reason: null, personAsked: false, recheck: false, updatedAt: now },
  ]
  dbQueryHandler = (q, params, rowMode) => {
    const asRows = (objs: Record<string, unknown>[], cols: string[]) =>
      rowMode === 'array' ? objs.map(obj => cols.map(c => obj[c])) : objs
    if (q.startsWith('select "id", "userId", "matterKey"') && q.includes('from "attention_matters"')) {
      const full = attentionOpenRows.map(row => ({
        id: row.id, userId: row.userId, matterKey: row.id, source: 'gmail', suggestionId: null,
        title: row.title, url: null, level: row.level, assessment: {}, evidence: { latest: { occurredAt: now.toISOString(), summary: 'ping' } },
        state: row.state, reason: row.reason, runAt: null, recheck: row.recheck, personAsked: row.personAsked,
        handoffs: 1, handedAt: now, createdAt: now, updatedAt: row.updatedAt,
      }))
      return asRows(full, ['id', 'userId', 'matterKey', 'source', 'suggestionId', 'title', 'url', 'level', 'assessment', 'evidence', 'state', 'reason', 'runAt', 'recheck', 'personAsked', 'handoffs', 'handedAt', 'createdAt', 'updatedAt'])
    }
    if (q.startsWith('update "attention_matters"') && q.includes('returning "id"')) {
      const ids = params.filter((p): p is string => p === MATTER_1 || p === MATTER_2 || p === MATTER_3)
      const unique = [...new Set(ids)]
      return asRows(unique.map(id => ({ id })), ['id'])
    }
    if (q.includes('from "attention_settings"')) {
      return asRows([{ enabled: false }], ['enabled'])
    }
    return []
  }

  await attentionStore.settleTurn(OWNER, [MATTER_1, MATTER_2, MATTER_3], true, now)
  const updates = sqlLog.filter(entry => entry.sql.startsWith('update "attention_matters"'))
  const logInserts = sqlLog.filter(entry => entry.sql.startsWith('insert into "attention_log"'))
  assert.equal(updates.length, 1, 'toldPerson settleTurn must batch all handed matters into 1 UPDATE')
  assert.equal(logInserts.length, 1, 'toldPerson settleTurn must batch all attention_log rows into 1 INSERT')

  // Also test Decisions settlement path (1 quiet + 2 snoozed with distinct windows)
  sqlLog = []
  let callIndex = 0
  await attentionStore.settleTurn(OWNER, [MATTER_1, MATTER_2, MATTER_3], false, now, async () => {
    callIndex++
    if (callIndex === 1) return new Map([['settle', { type: 'choice', choice: 'quiet' }]])
    if (callIndex === 2) return new Map([['settle', { type: 'choice', choice: 'snooze' }], ['retryIn', { type: 'choice', choice: '2h' }]])
    return null
  })
  const settleUpdates = sqlLog.filter(entry => entry.sql.startsWith('update "attention_matters"'))
  const settleLogs = sqlLog.filter(entry => entry.sql.startsWith('insert into "attention_log"'))
  assert.equal(settleUpdates.length, 2, '1 batched UPDATE for quiet + 1 batched CASE UPDATE for 2 snoozed matters')
  assert.match(settleUpdates[1]!.sql, /case when/, 'multi-matter snooze settlement uses single CASE UPDATE')
  assert.equal(settleLogs.length, 1, 'all settlement logs must insert in 1 batched INSERT')
})

test('P0 #5 & P1 source contracts: bounded limits, CTE dedup, batched mutations, and valid CONCURRENTLY migration', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  // P0 #5 bounds
  const deviceLink = read('lib/device-link.ts')
  assert.match(deviceLink, /export const DEVICE_WORK_RUN_LIMIT = 500/)
  assert.match(deviceLink, /\.limit\(DEVICE_WORK_RUN_LIMIT\)/)
  assert.match(deviceLink, /resolveMessageReferencesBatch/)

  const coordStore = read('lib/coordinator/store.ts')
  assert.match(coordStore, /export const COORDINATOR_CONVERSATION_ROW_LIMIT = 500/)
  assert.match(coordStore, /\.orderBy\(desc\(coordinatorMessages\.position\)\)\s*\.limit\(COORDINATOR_CONVERSATION_ROW_LIMIT\)/)

  const agentRunsSrc = read('lib/agent-runs.ts')
  assert.match(agentRunsSrc, /export const RUN_MESSAGES_LIMIT = 1_000/)
  assert.match(agentRunsSrc, /export const RUN_CHUNKS_LIMIT = 5_000/)
  assert.match(agentRunsSrc, /orderBy\(desc\(runChunks\.seq\)\)\.limit\(chunkLimit\)/)
  assert.match(agentRunsSrc, /orderBy\(desc\(runMessages\.createdAt\), desc\(runMessages\.id\)\)\s*\.limit\(limit\)/)

  const mobileThreadRoute = read('app/api/mobile/threads/[id]/route.ts')
  assert.match(mobileThreadRoute, /readRun\(user\.id, id\.data, 'latest-events'\)/)
  assert.match(mobileThreadRoute, /\.limit\(RUN_CHUNKS_LIMIT\)/)
  assert.match(mobileThreadRoute, /const messages = detail\.run\.agentId \? await readRunMessages\(user\.id, runIds\) : \[\]/)

  // P1 CTE dedup & batched mutations
  const issuesAction = read('app/actions/issues.ts')
  assert.match(issuesAction, /db\.\$with\('task_list'\)\.as\(candidateQuery\)/)
  assert.match(issuesAction, /queryVersionFromRowSignatures\(/)

  const issueOps = read('app/actions/issue-operations.ts')
  assert.doesNotMatch(issueOps, /for \(const \[id, patch\] of patches\)/)
  assert.match(issueOps, /tx\.insert\(issues\)\.values\(copyValues\)/)

  const projectsAction = read('app/actions/projects.ts')
  assert.match(projectsAction, /where\(inArray\(projectTasks\.projectId, linked\.map\(project => project\.id\)\)\)/)
  assert.match(projectsAction, /where\(inArray\(projects\.id, orderedProjects\.map\(project => project\.id\)\)\)/)

  // Additive CONCURRENTLY index migration on factory_events
  const migrationFiles = fs.readdirSync(path.join(root, 'drizzle')).filter(f => f.endsWith('_factory_events_task_kind_idx.sql'))
  assert.equal(migrationFiles.length, 1)
  const migrationSql = read(path.join('drizzle', migrationFiles[0]!))
  const planned = planMigration(migrationFiles[0]!, migrationSql)
  assert.equal(planned.target, 'MIKKA_DATABASE_URL')
  assert.equal(planned.noTransaction, true)
  assert.equal(planned.concurrentIndex, 'factory_events_task_kind_idx')
  assert.equal(planned.concurrentIndexTable?.table, 'factory_events')
})
