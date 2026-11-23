// Real isolated PostgreSQL (#2939): a sub-agent is a child run of the run that dispatched it. The parent's owner reads
// every child with what its card shows; nobody else reads anything, and the edge never crosses owner or Workspace.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('sub-agent child runs', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { linkSubagentRun, readSubagentRuns, recordDispatchBrief, SubagentLinkError } = await import('../lib/subagent-run-read')
  const { subagentCardOf } = await import('../lib/subagent-card')
  const { runLiveTargets } = await import('../lib/live/panels')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'crew-owner')
  const teammate = await seedUser(pool, 'crew-teammate')
  const stranger = await seedUser(pool, 'crew-stranger')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const claude = await seedAgent(pool, owner, 'claude_code')
  const codex = await seedAgent(pool, owner, 'codex')
  const run = (agentId: string, status = 'succeeded', workspaceId = workspace.id, userId = owner) => seedRun(pool, { userId, agentId, workspaceId, status })

  const parent = await run(claude, 'running')
  const researcher = await run(claude, 'running')
  const coder = await run(codex, 'queued')
  const profile = randomUUID()
  await pool.query(`INSERT INTO factory_agent_profiles (id,"ownerId","workspaceId",version,definition,digest,icon,color) VALUES ($1,$2,$3,1,$4,repeat('a',64),'lens','teal')`,
    [profile, owner, workspace.id, JSON.stringify({ name: 'Researcher', description: '', roles: [] })])
  await pool.query(`UPDATE agent_runs SET "agentDefinition"=$2,"observedModel"='claude-opus-5-5',"createdAt"=now()+interval '1 second' WHERE id=$1`, [researcher,
    JSON.stringify({ model: 'claude-sonnet-5', agentProfile: { profileId: profile, name: 'Researcher', definition: { roles: ['research'], description: '' } } })])
  await pool.query(`UPDATE agent_runs SET "agentDefinition"=$2,"createdAt"=now()+interval '2 seconds' WHERE id=$1`, [coder, JSON.stringify({ model: 'gpt-6-luna' })])

  const teammateAgent = await seedAgent(pool, teammate)
  const foreign = await run(teammateAgent, 'running', workspace.id, teammate)
  const elsewhere = await run(claude, 'running', other.id)

  await t.test('a parent dispatches two children; its owner reads both cards with every field', async () => {
    await linkSubagentRun(pool, owner, { parentRunId: parent, childRunId: researcher, brief: '  找出购物车为空时\n结账崩溃的位置  ' })
    await linkSubagentRun(pool, owner, { parentRunId: parent, childRunId: coder, brief: '加空购物车的保护并补单测' })
    // A retried dispatch is safe and keeps the line it was first handed.
    await linkSubagentRun(pool, owner, { parentRunId: parent, childRunId: coder, brief: 'another line' })
    const children = await readSubagentRuns(pool, { ownerId: owner, workspaceId: workspace.id, runId: parent })
    assert.ok(children)
    assert.deepEqual(children.map(child => subagentCardOf(child)), [
      { id: researcher, name: 'Researcher', profile: { icon: 'lens', color: 'teal' }, model: 'Opus 5.5', status: 'working', brief: '找出购物车为空时 结账崩溃的位置' },
      { id: coder, name: 'Codex', profile: subagentCardOf({ id: coder, harness: 'codex', status: 'queued' }).profile, model: 'GPT-6 Luna', status: 'queued', brief: '加空购物车的保护并补单测' },
    ])
    assert.deepEqual(children.map(child => [child.latestRunId, child.harness]), [[researcher, 'claude_code'], [coder, 'codex']])
  })

  await t.test('a child shows the state of its own thread\'s newest run', async () => {
    const next = await run(claude, 'waiting_input')
    await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=$1`, [researcher])
    await pool.query(`UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=now()+interval '5 seconds' WHERE id=$1`, [next, researcher])
    const [first] = (await readSubagentRuns(pool, { ownerId: owner, workspaceId: workspace.id, runId: parent }))!
    assert.equal(first.id, researcher)
    assert.equal(first.latestRunId, next)
    assert.equal(subagentCardOf(first).status, 'needs-you')
    assert.equal(first.subagent.brief, '找出购物车为空时 结账崩溃的位置', 'the brief belongs to the dispatch, not the continuation')
    const targets = await runLiveTargets(pool, pool, next, 'run')
    assert.ok(targets[0]?.events.some(event => event.kind === 'run' && event.id === parent), 'a continuation\'s change wakes the parent thread')
  })

  await t.test('a child\'s change wakes its parent\'s run key, for the owner only', async () => {
    const targets = await runLiveTargets(pool, pool, coder, 'run')
    assert.deepEqual(targets, [{ scope: { ownerId: owner, workspaceId: workspace.id }, events: [{ kind: 'run', id: coder }, { kind: 'run', id: parent }] }])
    assert.deepEqual((await runLiveTargets(pool, pool, coder, 'thread'))[0].events, [{ kind: 'thread', id: coder }])
  })

  await t.test('a non-owner, another member, another Workspace and a foreign run read nothing', async () => {
    assert.equal(await readSubagentRuns(pool, { ownerId: stranger, workspaceId: workspace.id, runId: parent }), null)
    assert.equal(await readSubagentRuns(pool, { ownerId: teammate, workspaceId: workspace.id, runId: parent }), null)
    assert.equal(await readSubagentRuns(pool, { ownerId: owner, workspaceId: other.id, runId: parent }), null)
    assert.equal(await readSubagentRuns(pool, { ownerId: owner, workspaceId: workspace.id, runId: foreign }), null)
    assert.equal(await readSubagentRuns(pool, { ownerId: owner, workspaceId: workspace.id, runId: 'not-a-uuid' }), null)
    assert.deepEqual(await readSubagentRuns(pool, { ownerId: owner, workspaceId: workspace.id, runId: coder }), [], 'a child with no children of its own lists none')
  })

  await t.test('the edge stays in one owner and Workspace, is set once and never loops', async () => {
    const code = async (work: Promise<unknown>) => { try { await work; return 'linked' } catch (error) { return error instanceof SubagentLinkError ? error.code : String(error) } }
    const loose = await run(claude, 'queued')
    assert.equal(await code(linkSubagentRun(pool, owner, { parentRunId: foreign, childRunId: loose })), 'runNotFound', 'a teammate\'s run cannot be the parent')
    assert.equal(await code(linkSubagentRun(pool, teammate, { parentRunId: foreign, childRunId: loose })), 'runNotFound', 'nobody else can adopt the owner\'s run')
    assert.equal(await code(linkSubagentRun(pool, owner, { parentRunId: elsewhere, childRunId: loose })), 'subagentParentMismatch', 'another Workspace\'s run')
    assert.equal(await code(linkSubagentRun(pool, owner, { parentRunId: loose, childRunId: loose })), 'subagentParentMismatch', 'itself')
    assert.equal(await code(linkSubagentRun(pool, owner, { parentRunId: researcher, childRunId: coder })), 'subagentParentFixed', 'a second parent')
    assert.equal(await code(linkSubagentRun(pool, owner, { parentRunId: coder, childRunId: parent })), 'subagentParentCycle', 'a loop')
    await assert.rejects(pool.query('UPDATE agent_runs SET "parentRunId"=$2 WHERE id=$1', [loose, foreign]), { code: '23514' }, 'the database refuses a cross-owner edge on its own')
    assert.equal((await pool.query('SELECT "parentRunId" FROM agent_runs WHERE id=$1', [loose])).rows[0].parentRunId, null)
  })

  await t.test('a dispatch brief is written once, only on the owner\'s run', async () => {
    const loose = await run(claude, 'queued')
    assert.equal(await recordDispatchBrief(pool, teammate, loose, '不是我的'), false)
    assert.equal(await recordDispatchBrief(pool, owner, loose, '   '), false)
    assert.equal(await recordDispatchBrief(pool, owner, loose, '更新 CHANGELOG 和结账说明'), true)
    assert.equal(await recordDispatchBrief(pool, owner, loose, '再写一次'), false)
    assert.equal((await pool.query('SELECT brief FROM agent_runs WHERE id=$1', [loose])).rows[0].brief, '更新 CHANGELOG 和结账说明')
  })

  await t.test('deleting the parent leaves its children as threads of their own', async () => {
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [parent])
    assert.deepEqual((await pool.query('SELECT "parentRunId" FROM agent_runs WHERE id=ANY($1::uuid[])', [[researcher, coder]])).rows, [{ parentRunId: null }, { parentRunId: null }])
  })
})
