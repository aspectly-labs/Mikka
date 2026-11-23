// Real isolated PostgreSQL: an Agent's live plan is read over all of its run's chunks, so a plan written before the
// newest transcript page still shows; it is the run owner's only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('live plan read', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readRunPlan } = await import('../lib/thread-plan-read')
  const { readLatestThreadHistory } = await import('../lib/thread-history-read')
  const { THREAD_HISTORY_PAGE_SIZE } = await import('../lib/thread-history')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'plan-owner')
  const teammate = await seedUser(pool, 'plan-teammate')
  const stranger = await seedUser(pool, 'plan-stranger')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  await seedWorkspace(pool, stranger, [{ userId: stranger, role: 'admin' }])
  const agent = await seedAgent(pool, owner, 'claude_code')
  const run = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, status: 'running' })
  const teammateRun = await seedRun(pool, { userId: teammate, agentId: await seedAgent(pool, teammate, 'claude_code'), workspaceId: workspace.id, status: 'running' })

  let seq = 0
  const insert = (runId: string, chunk: Record<string, unknown>) =>
    pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,$3,$4)', [randomUUID(), runId, ++seq, JSON.stringify(chunk)])
  const todo = (id: string, items: [string, string][]) => ({ type: 'tool-input-available', toolCallId: id, toolName: 'TodoWrite',
    input: { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) } })
  // The plan and a task the newer tools add, then more than a page of the run's words.
  await insert(run, todo('todo-1', [['Read the brief', 'completed'], ['Write the parser', 'in_progress'], ['Add tests', 'pending']]))
  await insert(run, { type: 'tool-output-available', toolCallId: 'todo-1', output: 'ok' })
  await insert(run, { type: 'tool-input-available', toolCallId: 'task-1', toolName: 'TaskCreate', input: { subject: 'Review', description: 'x' } })
  await insert(run, { type: 'tool-output-available', toolCallId: 'task-1', output: 'Task #1 created', planTask: { id: '1' } })
  await insert(run, { type: 'tool-input-available', toolCallId: 'read-1', toolName: 'Read', input: { file_path: 'a.ts' } })
  await insert(run, { type: 'tool-output-available', toolCallId: 'read-1', output: 'export {}' })
  for (let i = 0; i < THREAD_HISTORY_PAGE_SIZE + 10; i += 1) await insert(run, { type: 'text-delta', id: 'words', delta: `${i} ` })
  // A later update addresses the task the early create named.
  await insert(run, { type: 'tool-input-available', toolCallId: 'task-2', toolName: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } })
  await insert(teammateRun, todo('todo-t', [['Teammate step', 'pending']]))

  await t.test('a plan call older than the newest page still makes the plan', async () => {
    const page = await readLatestThreadHistory([run], undefined)
    assert.ok(!page.chunks.some(({ chunk }) => chunk.toolName === 'TodoWrite' || chunk.toolName === 'TaskCreate'), 'the newest page leaves the plan calls out')
    const plan = await readRunPlan(pool, { runId: run, ownerId: owner })
    assert.deepEqual(plan?.map(item => [item.text, item.status]), [
      ['Read the brief', 'completed'], ['Write the parser', 'in_progress'], ['Add tests', 'pending'], ['Review', 'in_progress'],
    ])
  })

  await t.test('only the run owner reads it', async () => {
    assert.equal(await readRunPlan(pool, { runId: run, ownerId: teammate }), null, 'another member of the workspace')
    assert.equal(await readRunPlan(pool, { runId: run, ownerId: stranger }), null, 'someone in another workspace')
    assert.equal(await readRunPlan(pool, { runId: teammateRun, ownerId: owner }), null, "a foreign run, even one the reader's workspace holds")
    assert.equal(await readRunPlan(pool, { runId: randomUUID(), ownerId: owner }), null, 'a run that does not exist')
    assert.deepEqual((await readRunPlan(pool, { runId: teammateRun, ownerId: teammate }))?.map(item => item.text), ['Teammate step'])
  })

  await t.test('a run without plan calls has none', async () => {
    const quiet = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, status: 'running' })
    await insert(quiet, { type: 'text-delta', id: 'w', delta: 'hi' })
    assert.equal(await readRunPlan(pool, { runId: quiet, ownerId: owner }), null)
  })
})
