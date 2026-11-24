import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { tokenWorkspace } from './tokens/principal'

const OWNER = 'owner-user'
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'
const ROOT_RUN = '33333333-3333-4333-8333-333333333333'
const CHILD_CONT = '44444444-4444-4444-8444-444444444444'
const OLD_TASK = '55555555-5555-4555-8555-555555555555'
const NEW_TASK = '66666666-6666-4666-8666-666666666666'
const FORBIDDEN_TASK = '77777777-7777-4777-8777-777777777777'
const SUBAGENT_RUN = '88888888-8888-4888-8888-888888888888'

type FakeRun = {
  id: string
  userId: string
  workspaceId: string | null
  issueId: string | null
  threadRelation: 'fork' | 'side' | 'subagent' | null
  kind: string
  independentCheck?: boolean
  deletedAt: Date | null
  tags: string[] | null
  finishedAt: Date | null
  createdAt: Date
  parentRunId: string | null
  status: string
  outcome: string | null
  title: string | null
  sourceMessageId: string | null
}

let state: {
  runs: Map<string, FakeRun>
  chains: Map<string, { rootRunId: string; latestRunId: string; attempts: { runId: string; attempt: number; status: string; stopRequestedAt: null; createdAt: Date; finishedAt: Date | null }[] }>
  allowedTasks: Set<string>
  outsideChecks: Array<{ workspaceId: string | undefined; runId: string }>
  liveEvents: string[]
  updatedChains: Array<{ chainIds: string[]; issueId: string | null }>
}

function resetState() {
  const now = new Date('2026-11-24T10:00:00.000Z')
  const finished = new Date('2026-11-24T10:05:00.000Z')
  const runs = new Map<string, FakeRun>([
    [ROOT_RUN, {
      id: ROOT_RUN, userId: OWNER, workspaceId: WORKSPACE, issueId: OLD_TASK,
      threadRelation: null, kind: 'implement', deletedAt: null, tags: null,
      finishedAt: finished, createdAt: now, parentRunId: null, status: 'succeeded',
      outcome: 'done', title: 'Root thread', sourceMessageId: null,
    }],
    [CHILD_CONT, {
      id: CHILD_CONT, userId: OWNER, workspaceId: WORKSPACE, issueId: OLD_TASK,
      threadRelation: null, kind: 'implement', deletedAt: null, tags: null,
      finishedAt: null, createdAt: finished, parentRunId: null, status: 'running',
      outcome: null, title: 'Root thread', sourceMessageId: null,
    }],
    [SUBAGENT_RUN, {
      id: SUBAGENT_RUN, userId: OWNER, workspaceId: WORKSPACE, issueId: OLD_TASK,
      threadRelation: 'subagent', kind: 'implement', deletedAt: null, tags: null,
      finishedAt: finished, createdAt: now, parentRunId: ROOT_RUN, status: 'succeeded',
      outcome: 'done', title: 'Audit subagent', sourceMessageId: null,
    }],
  ])
  const chains = new Map([
    [ROOT_RUN, {
      rootRunId: ROOT_RUN,
      latestRunId: CHILD_CONT,
      attempts: [
        { runId: ROOT_RUN, attempt: 1, status: 'succeeded', stopRequestedAt: null, createdAt: now, finishedAt: finished },
        { runId: CHILD_CONT, attempt: 2, status: 'running', stopRequestedAt: null, createdAt: finished, finishedAt: null },
      ],
    }],
    [CHILD_CONT, {
      rootRunId: ROOT_RUN,
      latestRunId: CHILD_CONT,
      attempts: [
        { runId: ROOT_RUN, attempt: 1, status: 'succeeded', stopRequestedAt: null, createdAt: now, finishedAt: finished },
        { runId: CHILD_CONT, attempt: 2, status: 'running', stopRequestedAt: null, createdAt: finished, finishedAt: null },
      ],
    }],
    [SUBAGENT_RUN, {
      rootRunId: SUBAGENT_RUN,
      latestRunId: SUBAGENT_RUN,
      attempts: [
        { runId: SUBAGENT_RUN, attempt: 1, status: 'succeeded', stopRequestedAt: null, createdAt: now, finishedAt: finished },
      ],
    }],
  ])
  state = {
    runs,
    chains,
    allowedTasks: new Set([`${WORKSPACE}:${NEW_TASK}`, `${WORKSPACE}:${OLD_TASK}`]),
    outsideChecks: [],
    liveEvents: [],
    updatedChains: [],
  }
}

let lifecycle: typeof import('./thread-lifecycle')
let taskRunsActions: typeof import('../app/actions/task-runs')
let subagentRead: typeof import('./subagent-run-read')
let subagentCards: typeof import('./subagent-runs')
let directory: typeof import('./conversation-directory')

const dbSelectRows: unknown[][] = []

function fakeQuery(sql: string, params: unknown[] = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim()
  // ownedRun
  if (normalized.startsWith('SELECT * FROM agent_runs WHERE id=$1')) {
    const run = state.runs.get(String(params[0]))
    if (!run || (normalized.includes('"deletedAt" IS NULL') && run.deletedAt)) return { rows: [] }
    return { rows: [{ ...run }] }
  }
  // patchThread root metadata + lockedFactoryRun
  if (normalized.includes('AS "lockedFactoryRun" FROM agent_runs r WHERE r.id=$1')) {
    assert.match(normalized, /a\.stage IN \('review','verify','monitor'\)/)
    assert.match(normalized, /a\.status IN \('pending','running','waiting'\)/)
    const run = state.runs.get(String(params[0]))
    if (!run || run.userId !== params[1] || run.deletedAt) return { rows: [] }
    return { rows: [{ id: run.id, issueId: run.issueId, workspaceId: run.workspaceId, threadRelation: run.threadRelation, kind: run.kind, lockedFactoryRun: Boolean(run.independentCheck) }] }
  }
  // patchThread task validation (workspace + bound + not deleted + canSteer ACL)
  if (normalized.startsWith('SELECT id FROM issues WHERE id=$1 AND "workspaceId"=$2')) {
    assert.match(normalized, /"ownershipState"='bound'/)
    assert.match(normalized, /deletedAt/)
    assert.match(normalized, /mikka_resource_acl_allowed\('account',\$3,"workspaceId",'task',id,'canSteer'\)/)
    const key = `${params[1]}:${params[0]}`
    return { rows: state.allowedTasks.has(key) ? [{ id: params[0] }] : [] }
  }
  // patchThread atomic recursive chain + Factory lock + root ACL parent update
  if (normalized.startsWith('WITH RECURSIVE chain AS ( SELECT id FROM agent_runs WHERE id=$1')) {
    assert.match(normalized, /r\."continuesRunId"=chain\.id OR r\."retryOf"=chain\.id/)
    assert.match(normalized, /a\.status IN \('pending','running','waiting'\)/)
    assert.match(normalized, /UPDATE resource_access_policies SET "parentKind"=\$5,"parentId"=\$2::uuid/)
    const rootId = String(params[0])
    const nextIssueId = params[1] as string | null
    const ownerId = String(params[2])
    const workspaceId = params[3] as string | null
    const previousIssueId = params[5] as string | null
    assert.equal(params[4], nextIssueId ? 'task' : null)
    const chain = state.chains.get(rootId)
    const chainIds = chain ? chain.attempts.map(a => a.runId) : [rootId]
    const root = state.runs.get(rootId)
    if (!root || root.issueId !== previousIssueId || root.independentCheck) return { rows: [{ moved: false }] }
    state.updatedChains.push({ chainIds, issueId: nextIssueId })
    for (const id of chainIds) {
      const run = state.runs.get(id)
      if (run && run.userId === ownerId && run.workspaceId === workspaceId && run.issueId === previousIssueId) run.issueId = nextIssueId
    }
    return { rows: [{ moved: true }], rowCount: 1 }
  }
  // patchThread tags update
  if (normalized.startsWith('UPDATE agent_runs SET tags=$2::jsonb WHERE id=$1')) {
    const run = state.runs.get(String(params[0]))
    if (run && run.userId === params[2]) run.tags = JSON.parse(String(params[1]))
    return { rows: [], rowCount: run ? 1 : 0 }
  }
  // listThreadChildren
  if (normalized.startsWith('SELECT id,"threadRelation",kind,status,outcome,title,"sourceMessageId","createdAt","finishedAt" FROM agent_runs WHERE "parentRunId"=$1')) {
    const rows = [...state.runs.values()]
      .filter(r => r.parentRunId === params[0] && !r.deletedAt)
      .map(r => ({
        id: r.id, threadRelation: r.threadRelation, kind: r.kind, status: r.status,
        outcome: r.outcome, title: r.title, sourceMessageId: r.sourceMessageId,
        createdAt: r.createdAt, finishedAt: r.finishedAt,
      }))
    return { rows }
  }
  throw new Error(`Unexpected SQL in test fixture: ${normalized}`)
}

before(async () => {
  resetState()
  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers({ cookie: 'session=test' }) } })
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: OWNER }, session: { id: 'sess-1' } }) } } } })
  mock.module('@/lib/workspace-access', {
    namedExports: {
      WorkspaceError: class WorkspaceError extends Error {},
      requireWorkspace: async () => ({ workspace: { id: WORKSPACE, kind: 'team' }, membership: { role: 'admin' } }),
      loadWorkspaceContext: async () => ({ workspace: { id: WORKSPACE, kind: 'team' } }),
      loadWorkspaceSettings: async () => ({ workspace: { id: WORKSPACE, kind: 'team' } }),
    },
  })
  mock.module('@/lib/tokens/scope', {
    namedExports: {
      runOutsideToken: async (user: { id: string; [tokenWorkspace]?: string }, runId: string) => {
        state.outsideChecks.push({ workspaceId: user[tokenWorkspace], runId })
        const run = state.runs.get(runId)
        return !user[tokenWorkspace] || !run || run.workspaceId !== user[tokenWorkspace]
      },
      runsOutsideToken: async (user: { id: string; [tokenWorkspace]?: string }, runIds: readonly string[]) => {
        const out = new Set<string>()
        for (const id of runIds) {
          const run = state.runs.get(id)
          if (!user[tokenWorkspace] || !run || run.workspaceId !== user[tokenWorkspace]) out.add(id)
        }
        return out
      },
    },
  })
  mock.module('@/lib/run-chain', {
    namedExports: {
      RUN_CHAIN_MAX_DEPTH: 64,
      runChainSql: (scope: string, depth: string) => `runs AS (SELECT id FROM agent_runs r WHERE ${scope}), assigned AS (SELECT id, id AS root, false AS "depthExceeded" FROM runs WHERE ${depth} > 0)`,
      readRunChain: async (_q: unknown, userId: string, runId: string) => {
        const run = state.runs.get(runId)
        if (!run || run.userId !== userId) return null
        return state.chains.get(runId) ?? null
      },
    },
  })
  mock.module('@/lib/live/lists', {
    namedExports: {
      runListChanged: async (_pool: unknown, id: string) => { state.liveEvents.push(`runList:${id}`) },
      groupListChanged: async () => {},
    },
  })
  mock.module('@/lib/live/panels', {
    namedExports: {
      runChanged: async (_pool: unknown, id: string) => { state.liveEvents.push(`run:${id}`) },
      issueThreadsChanged: async (_pool: unknown, issueId: string) => { state.liveEvents.push(`issueThreads:${issueId}`) },
    },
  })
  mock.module('@/lib/device-gateway-notify', { namedExports: { notifyDeviceWork: () => {} } })
  mock.module('@/lib/device-repositories', { namedExports: { ensureDeviceRepository: async () => ({ id: 'repo-1' }) } })
  mock.module('@/lib/execution-identity', { namedExports: { rebindExecutionDevice: async () => null, ExecutionIdentityError: class extends Error {} } })
  mock.module('@/lib/schedules/runtime', { namedExports: { schedules: () => ({ command: async () => ({}) }) } })
  mock.module('@/lib/conversation-workspace', {
    namedExports: {
      withConversationWorkspace: async (_reader: unknown, _ws: string, fn: () => Promise<unknown>) => fn(),
    },
  })
  mock.module('@/lib/group-task-links', { namedExports: { linkedTasksForChats: async () => new Map() } })
  mock.module('@/lib/db', {
    namedExports: {
      pool: { query: async (sql: string, params?: unknown[]) => fakeQuery(sql, params) },
      db: {
        select: () => {
          const rows = dbSelectRows.shift() ?? []
          const q = Promise.resolve(rows)
          Object.assign(q, { from: () => q, where: () => q, orderBy: () => q, limit: () => q })
          return q
        },
      },
    },
  })

  lifecycle = await import('./thread-lifecycle')
  taskRunsActions = await import('../app/actions/task-runs')
  subagentRead = await import('./subagent-run-read')
  subagentCards = await import('./subagent-runs')
  directory = await import('./conversation-directory')
})

beforeEach(() => {
  resetState()
  dbSelectRows.length = 0
})

test('updateThread pins workspace token scope in conversationActor and links the whole run chain while notifying both old and new tasks', async () => {
  const result = await taskRunsActions.updateThread(CHILD_CONT, { taskId: NEW_TASK })
  assert.deepEqual(result, { updated: true })
  assert.deepEqual(state.outsideChecks, [{ workspaceId: WORKSPACE, runId: CHILD_CONT }])
  assert.deepEqual(state.updatedChains, [{ chainIds: [ROOT_RUN, CHILD_CONT], issueId: NEW_TASK }])
  assert.equal(state.runs.get(ROOT_RUN)?.issueId, NEW_TASK)
  assert.equal(state.runs.get(CHILD_CONT)?.issueId, NEW_TASK)
  assert.deepEqual(state.liveEvents, [`runList:${ROOT_RUN}`, `run:${ROOT_RUN}`, `issueThreads:${OLD_TASK}`])
})

test('updateThread supports unlinking (taskId: null) and notifies previous task', async () => {
  const result = await taskRunsActions.updateThread(ROOT_RUN, { taskId: null })
  assert.deepEqual(result, { updated: true })
  assert.equal(state.runs.get(ROOT_RUN)?.issueId, null)
  assert.equal(state.runs.get(CHILD_CONT)?.issueId, null)
  assert.deepEqual(state.liveEvents, [`runList:${ROOT_RUN}`, `run:${ROOT_RUN}`, `issueThreads:${OLD_TASK}`])
})

test('patchThread refuses unauthorized, deleted, unbound or cross-workspace target tasks and revoked source tasks', async () => {
  // Task in another workspace is refused even if owned by the same user.
  state.allowedTasks.add(`${OTHER_WORKSPACE}:${FORBIDDEN_TASK}`)
  const res = await taskRunsActions.updateThread(ROOT_RUN, { taskId: FORBIDDEN_TASK })
  assert.deepEqual(res, { error: 'taskNotFound' })
  assert.equal(state.runs.get(ROOT_RUN)?.issueId, OLD_TASK)
  assert.deepEqual(state.liveEvents, [])

  // Revoking access to the source task blocks both unlinking and moving away (cannot resurrect transcript).
  state.allowedTasks.delete(`${WORKSPACE}:${OLD_TASK}`)
  assert.deepEqual(await taskRunsActions.updateThread(ROOT_RUN, { taskId: null }), { error: 'taskNotFound' })
  assert.deepEqual(await taskRunsActions.updateThread(ROOT_RUN, { taskId: NEW_TASK }), { error: 'taskNotFound' })
  assert.equal(state.runs.get(ROOT_RUN)?.issueId, OLD_TASK)
  assert.deepEqual(state.updatedChains, [])
})

test('patchThread refuses retargeting subagents and independent checks', async () => {
  // Subagent run
  const sub = await taskRunsActions.updateThread(SUBAGENT_RUN, { taskId: NEW_TASK })
  assert.deepEqual(sub, { error: 'runNotFound' })
  assert.equal(state.runs.get(SUBAGENT_RUN)?.issueId, OLD_TASK)

  // Independent check by kind
  state.runs.get(ROOT_RUN)!.kind = 'factory_verify'
  assert.deepEqual(await taskRunsActions.updateThread(ROOT_RUN, { taskId: NEW_TASK }), { error: 'runNotFound' })

  // Independent check by factory_attempts stage
  state.runs.get(ROOT_RUN)!.kind = 'implement'
  state.runs.get(ROOT_RUN)!.independentCheck = true
  assert.deepEqual(await taskRunsActions.updateThread(ROOT_RUN, { taskId: NEW_TASK }), { error: 'runNotFound' })
  assert.deepEqual(state.updatedChains, [])
})

test('listThreadChildren projects finishedAt alongside createdAt', async () => {
  const children = await lifecycle.listThreadChildren({ id: OWNER, [tokenWorkspace]: WORKSPACE }, ROOT_RUN)
  assert.ok(children)
  assert.equal(children.length, 1)
  assert.equal(children[0].id, SUBAGENT_RUN)
  assert.equal((children[0].finishedAt as Date).toISOString(), '2026-11-24T10:05:00.000Z')
})

test('readSubagentRuns projects finishedAt from latest run and filters soft-deleted children', async () => {
  const queries: string[] = []
  const fakeDb = {
    async query(sql: string) {
      queries.push(sql.replace(/\s+/g, ' ').trim())
      if (sql.includes('SELECT "workspaceId" FROM agent_runs')) return { rows: [{ workspaceId: WORKSPACE }] }
      return {
        rows: [
          {
            id: SUBAGENT_RUN, latestRunId: SUBAGENT_RUN, issueId: OLD_TASK, title: 'Audit',
            harness: 'codex', status: 'succeeded', outcome: 'done', stopReason: null,
            createdAt: new Date('2026-11-24T10:00:00.000Z'),
            finishedAt: new Date('2026-11-24T10:05:00.000Z'),
            facts: [null, 'gpt-6-luna', 'Check authz'], rootBrief: 'Check authz',
          },
          {
            id: CHILD_CONT, latestRunId: CHILD_CONT, issueId: OLD_TASK, title: 'Running child',
            harness: 'claude_code', status: 'running', outcome: null, stopReason: null,
            createdAt: new Date('2026-11-24T10:06:00.000Z'),
            finishedAt: null,
            facts: [null, 'claude-haiku-5-5', 'Inspect UI'], rootBrief: 'Inspect UI',
          },
        ],
      }
    },
  }
  const rows = await subagentRead.readSubagentRuns(fakeDb, { ownerId: OWNER, workspaceId: WORKSPACE, runId: ROOT_RUN })
  assert.ok(rows)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].finishedAt, '2026-11-24T10:05:00.000Z')
  assert.equal(rows[1].finishedAt, null)
  assert.match(queries[1], /latest\."finishedAt"/)
  assert.match(queries[1], /c\."deletedAt" IS NULL/)
})

test('listSubagentRuns projects finishedAt as ISO string or null', async () => {
  dbSelectRows.push([{ id: ROOT_RUN }])
  dbSelectRows.push([
    {
      id: SUBAGENT_RUN, name: 'Reviewer', profile: null, brief: 'Check diff',
      status: 'succeeded', outcome: 'done', model: 'gpt-6-luna', botId: null, lastReply: 'LGTM',
      createdAt: new Date('2026-11-24T10:00:00.000Z'),
      finishedAt: new Date('2026-11-24T10:05:00.000Z'),
    },
    {
      id: CHILD_CONT, name: 'Verifier', profile: null, brief: 'Run tests',
      status: 'running', outcome: null, model: 'claude-haiku-5-5', botId: null, lastReply: null,
      createdAt: new Date('2026-11-24T10:06:00.000Z'),
      finishedAt: null,
    },
  ])
  const cards = await subagentCards.listSubagentRuns({ id: OWNER, [tokenWorkspace]: WORKSPACE }, ROOT_RUN)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].finishedAt, '2026-11-24T10:05:00.000Z')
  assert.equal(cards[1].finishedAt, null)
})

test('conversationDirectory excludes subagent child runs and searches by task identifier as well as title', async () => {
  let capturedSql = ''
  const fakeDb = {
    async query(sql: string) {
      capturedSql = sql.replace(/\s+/g, ' ').trim()
      return {
        rows: [
          {
            kind: 'run', pulls: [], unread: false, id: ROOT_RUN, title: 'Fix auth race',
            agentName: 'Codex', harness: 'codex', issueId: OLD_TASK, identifier: 'FRO-42',
            taskTitle: 'Auth race', status: 'in_progress', pinned: false,
            at: '2026-11-24T10:00:00.000000Z', asked: 'Fix auth race', state: 'idle',
            botId: null, position: 1,
          },
        ],
      }
    },
  }
  const page = await directory.conversationDirectory(fakeDb, { id: OWNER, [tokenWorkspace]: WORKSPACE }, WORKSPACE, { search: 'fro-42' })
  assert.match(capturedSql, /root\."threadRelation" IS DISTINCT FROM 'subagent'/)
  assert.match(capturedSql, /strpos\(lower\(coalesce\(identifier,''\)\),lower\(\$\d+\)\)>0/)
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].id, ROOT_RUN)
  assert.equal(page.items[0].identifier, 'FRO-42')
})
