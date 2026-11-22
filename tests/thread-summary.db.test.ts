// Real isolated PostgreSQL (#2935): a thread's summary is read from what Mikka
// already records for the run chain, for its owner in its workspace only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { CatalogModel } from '../lib/model-catalog'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

const catalogue: CatalogModel[] = [{ id: 'anthropic/claude-sonnet-5.5', vendor: 'anthropic', name: 'Claude Sonnet 5.5',
  contextWindow: 1_000_000, maxTokens: 64_000, pricing: null, tags: ['tool-use'], reasoning: [] }]

test('thread summary read', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readThreadSummary } = await import('../lib/thread-summary')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'summary-owner')
  const teammate = await seedUser(pool, 'summary-teammate')
  const outsider = await seedUser(pool, 'summary-outsider')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const agent = await seedAgent(pool, owner, 'claude_code')
  const issue = await seedIssue(pool, owner, workspace.id)
  const root = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: issue })
  const next = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: issue, status: 'running' })
  await pool.query('UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=now()+interval \'1 second\' WHERE id=$1', [next, root])
  // 400 ASCII characters of brief and 40 said since: 100 + 10 estimated tokens.
  await pool.query('UPDATE agent_runs SET prompt=$2 WHERE id=$1', [root, 'a'.repeat(400)])
  await pool.query('INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,$4)', [randomUUID(), next, owner, 'b'.repeat(40)])
  await pool.query(`UPDATE agent_runs SET "agentDefinition"='{"model":"claude-sonnet-5-5"}'::jsonb WHERE id=$1`, [next])

  // The live run is on a Cloudflare task machine created at standard-2, in a GitHub repository, on its task branch.
  const cloud = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'cloud','cloud')`, [cloud, owner])
  const repo = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/widgets','https://github.com/acme/widgets.git')`, [repo, cloud, owner])
  await pool.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1', [next, cloud, repo])
  await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId",lifecycle)
    VALUES ($1,$2,$3,$4,'cloudflare-task-v1',$5,'running',$6,'{"sponsoredSize":"standard-2"}'::jsonb)`, [next, workspace.id, owner, `sb-${randomUUID()}`, randomUUID(), cloud])
  await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",identifier,branch,"baseBranch")
    VALUES ($1,$2,$3,'https://github.com/acme/widgets.git','v2/github.com/acme/widgets','MIK-7','mikka/mik-7','main')`, [next, owner, issue])

  // A credits receipt records the part the platform funded at settlement; this one was charged in full.
  const receipt = (run: string, cost: number | null, source: string) => pool.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"costMicroUsd","billingSource","usageRunId","usageThreadId","platformMicroUsd")
    VALUES ($1,$2,'claude-sonnet','settled',$3,$4,$5,$6,$7)`, [randomUUID(), workspace.id, cost, source, run, root, source === 'credits' ? 0 : null])
  await receipt(root, 1_500, 'credits')
  await receipt(next, null, 'subscription') // a subscription's cost is unknown, never zero

  // A second thread of the owner on a laptop, in a local checkout with no remote, on a model the catalogue lacks.
  const laptop = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,platform) VALUES ($1,$2,'MacBook','darwin')`, [laptop, owner])
  const local = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/Users/owner/private-checkout')`, [local, laptop, owner])
  const solo = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
  await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"='{"model":"house-model-9"}'::jsonb WHERE id=$1`, [solo, laptop, local])

  const teammateAgent = await seedAgent(pool, teammate)
  const foreign = await seedRun(pool, { userId: teammate, agentId: teammateAgent, workspaceId: workspace.id })

  await t.test('the owner reads every field from the chain in one read', async () => {
    const summary = await readThreadSummary(pool, { ownerId: owner, workspaceId: workspace.id, runId: root, catalogue })
    assert.ok(summary)
    assert.equal(summary.threadId, root)
    assert.deepEqual(summary.cost, {
      credits: { microUsd: 1_500, unpricedReceipts: 0 },
      included: { microUsd: 0, unpricedReceipts: 1, bySource: { subscription: { microUsd: 0, unpricedReceipts: 1 }, api_key: { microUsd: 0, unpricedReceipts: 0 } } },
      covered: { microUsd: 0, receipts: 0 },
      fundingUnknown: { microUsd: 0, receipts: 0 },
    })
    assert.deepEqual(summary.machine, { kind: 'cloud', size: 'standard-2', state: 'running' })
    assert.deepEqual(summary.repo, { key: 'v2/github.com/acme/widgets', name: 'acme/widgets' })
    assert.equal(summary.branch, 'mikka/mik-7')
    assert.deepEqual(summary.context, { estimated: true, used: 110, max: 1_000_000, model: 'anthropic/claude-sonnet-5.5' })
    assert.deepEqual(await readThreadSummary(pool, { ownerId: owner, workspaceId: workspace.id, runId: next, catalogue }), summary)
  })

  await t.test('what is not recorded is null, and a local path never leaves the server', async () => {
    const summary = await readThreadSummary(pool, { ownerId: owner, workspaceId: workspace.id, runId: solo, catalogue })
    assert.ok(summary)
    assert.deepEqual(summary.machine, { kind: 'laptop', size: null, state: 'offline' })
    assert.equal(summary.repo, null)
    assert.equal(summary.branch, null)
    assert.deepEqual(summary.context, { estimated: true, used: 0, max: null, model: 'house-model-9' })
    assert.doesNotMatch(JSON.stringify(summary), /private-checkout/)
  })

  await t.test('only the owner in the thread\'s workspace reads it', async () => {
    const read = (ownerId: string, workspaceId: string, runId: string) => readThreadSummary(pool, { ownerId, workspaceId, runId, catalogue })
    assert.equal(await read(outsider, workspace.id, root), null, 'not a member')
    assert.equal(await read(teammate, workspace.id, root), null, 'another member of the workspace')
    assert.equal(await read(owner, other.id, root), null, 'the owner in another workspace')
    assert.equal(await read(owner, workspace.id, foreign), null, 'a run the owner does not own')
    assert.equal(await read(owner, workspace.id, 'not-a-uuid'), null)
  })
})
