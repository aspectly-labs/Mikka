// Real isolated PostgreSQL (#2928, #2940): a thread's machine workspace for the right column's Files and Setup tabs,
// read from what Mikka records for the run chain, for its owner in its workspace only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('thread workspace read', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readThreadWorkspace, readThreadMachineMetrics, readBotChatUploads } = await import('../lib/thread-workspace-read')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'workspace-owner')
  const teammate = await seedUser(pool, 'workspace-teammate')
  const outsider = await seedUser(pool, 'workspace-outsider')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const agent = await seedAgent(pool, owner, 'claude_code')
  const issue = await seedIssue(pool, owner, workspace.id)
  const root = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: issue })
  const next = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: issue, status: 'running' })
  await pool.query('UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=now()+interval \'1 second\' WHERE id=$1', [next, root])

  // The live run is in an E2B sandbox, in a GitHub checkout, admitted with an Environment whose setup installs packages.
  const cloud = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'cloud','cloud')`, [cloud, owner])
  const repo = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/widgets','https://github.com/acme/widgets.git')`, [repo, cloud, owner])
  const environment = { id: randomUUID(), revision: 3, name: 'mikka-dev', runtime: 'cloud', harness: 'any', variables: {}, secretIds: [],
    repositoryKeys: ['v2/github.com/acme/widgets'], setup: { command: 'pnpm install --frozen-lockfile', copyFiles: ['.env.example'], approved: true } }
  await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=jsonb_build_object('projectExecution',jsonb_build_object('environment',$4::jsonb)) WHERE id=$1`,
    [next, cloud, repo, JSON.stringify(environment)])
  const sandbox = `sb-${randomUUID()}`
  const machineStarted = new Date(Date.now() - 38 * 60_000)
  await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId","createdAt")
    VALUES ($1,$2,$3,$4,'mikka-dev',$5,'running',$6,$7)`, [next, workspace.id, owner, sandbox, randomUUID(), cloud, machineStarted])

  // Two files sent in the thread, one still a draft, one removed, one in another thread.
  const upload = async (runId: string, name: string, extra: { used?: boolean; removed?: boolean; at?: string } = {}) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO chat_attachments (id,"userId","runId",name,"mediaType",size,state,sha256,"inlineData","usedAt","removedAt","createdAt")
      VALUES ($1,$2,$3,$4,'text/plain',12,'ready',repeat('a',64),'\\x00',$5,$6,coalesce($7::timestamptz,now()))`,
    [id, owner, runId, name, extra.used === false ? null : new Date(), extra.removed ? new Date() : null, extra.at ?? null])
    return id
  }
  const brief = await upload(root, 'brief.md', { at: '2026-11-20T10:00:00Z' })
  const log = await upload(next, 'ci.log', { at: '2026-11-20T11:00:00Z' })
  await upload(next, 'draft.txt', { used: false })
  await upload(next, 'gone.txt', { removed: true })

  // A second thread on a laptop, in a local checkout with no remote, admitted with no Environment.
  const laptop = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,platform) VALUES ($1,$2,'MacBook','darwin')`, [laptop, owner])
  const local = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/Users/owner/private-checkout')`, [local, laptop, owner])
  const solo = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
  await pool.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1', [solo, laptop, local])

  const teammateAgent = await seedAgent(pool, teammate)
  const foreign = await seedRun(pool, { userId: teammate, agentId: teammateAgent, workspaceId: workspace.id })

  await t.test('the owner reads the checkout, machine, Environment and uploads of the chain', async () => {
    const read = await readThreadWorkspace(pool, { ownerId: owner, workspaceId: workspace.id, runId: root })
    assert.ok(read)
    assert.equal(read.threadId, root)
    assert.equal(read.liveRunId, next)
    assert.deepEqual(read.checkout, { runId: next, repoId: repo, key: 'v2/github.com/acme/widgets', name: 'acme/widgets' })
    assert.deepEqual(read.machine, { kind: 'cloud', state: 'running', size: null, name: null, startedAt: machineStarted.toISOString(), endedAt: null })
    assert.deepEqual(read.environment, { id: environment.id, name: 'mikka-dev', runtime: 'cloud',
      setup: { command: 'pnpm install --frozen-lockfile', copyFiles: ['.env.example'], approved: true }, repositories: ['v2/github.com/acme/widgets'] })
    assert.deepEqual(read.uploads.map(file => [file.id, file.name]), [[log, 'ci.log'], [brief, 'brief.md']], 'sent files only, newest first')
    assert.deepEqual(await readThreadWorkspace(pool, { ownerId: owner, workspaceId: workspace.id, runId: next }), read)
  })

  await t.test('a binding names the checkout; two bindings name none', async () => {
    await pool.query(`INSERT INTO coding_workspace_bindings ("runId","repoId","ownerId","workspaceId","repositoryKey") VALUES ($1,$2,$3,$4,'v2/github.com/acme/widgets')`, [next, repo, owner, workspace.id])
    assert.equal((await readThreadWorkspace(pool, { ownerId: owner, workspaceId: workspace.id, runId: next }))?.checkout?.repoId, repo)
    await pool.query(`INSERT INTO coding_workspace_bindings ("runId","repoId","ownerId","workspaceId","repositoryKey") VALUES ($1,$2,$3,$4,'v2/github.com/acme/other')`, [next, randomUUID(), owner, workspace.id])
    assert.equal((await readThreadWorkspace(pool, { ownerId: owner, workspaceId: workspace.id, runId: next }))?.checkout, null)
    await pool.query('DELETE FROM coding_workspace_bindings WHERE "runId"=$1', [next])
  })

  await t.test('what is not recorded is empty, and a local path never leaves the server', async () => {
    const read = await readThreadWorkspace(pool, { ownerId: owner, workspaceId: workspace.id, runId: solo })
    assert.ok(read)
    assert.deepEqual(read.checkout, { runId: solo, repoId: local, key: null, name: null })
    assert.equal(read.machine?.kind, 'laptop')
    assert.equal(read.machine?.name, 'MacBook')
    assert.equal(read.environment, null)
    assert.deepEqual(read.uploads, [])
    assert.doesNotMatch(JSON.stringify(read), /private-checkout/)
  })

  await t.test('only the owner in the thread\'s workspace reads it', async () => {
    const read = (ownerId: string, workspaceId: string, runId: string) => readThreadWorkspace(pool, { ownerId, workspaceId, runId })
    assert.equal(await read(outsider, workspace.id, root), null, 'not a member')
    assert.equal(await read(teammate, workspace.id, root), null, 'another member of the workspace')
    assert.equal(await read(owner, other.id, root), null, 'the owner in another workspace')
    assert.equal(await read(owner, workspace.id, foreign), null, 'a run the owner does not own')
    assert.equal(await read(owner, workspace.id, 'not-a-uuid').catch(() => null), null)
  })

  await t.test('metrics come from the live sandbox\'s recorded samples, never for anyone else', async () => {
    const asked: string[] = []
    const samples = async (ownerId: string, sandboxId: string) => {
      asked.push(`${ownerId}:${sandboxId}`)
      return [
        { timestamp: new Date(Date.now() - 60_000), cpuCount: 4, cpuUsedPct: 10, memUsed: 1, memTotal: 8, diskUsed: 2, diskTotal: 40 },
        { timestamp: new Date(Date.now() - 10_000), cpuCount: 4, cpuUsedPct: 23, memUsed: 3, memTotal: 8, diskUsed: 11, diskTotal: 40 },
        { timestamp: 'garbage' },
      ]
    }
    const metrics = await readThreadMachineMetrics(pool, { ownerId: owner, workspaceId: workspace.id, runId: root }, samples)
    assert.equal(metrics?.cpuUsedPct, 23)
    assert.equal(metrics?.diskUsed, 11)
    assert.deepEqual(asked, [`${owner}:${sandbox}`])
    for (const [ownerId, workspaceId, runId] of [[teammate, workspace.id, root], [outsider, workspace.id, root], [owner, other.id, root], [owner, workspace.id, foreign]])
      assert.equal(await readThreadMachineMetrics(pool, { ownerId, workspaceId, runId }, samples), null)
    assert.equal(await readThreadMachineMetrics(pool, { ownerId: owner, workspaceId: workspace.id, runId: solo }, samples), null, 'a computer has no sandbox metrics')
    assert.equal(asked.length, 1, 'a denied or local read never asks the provider')
  })

  await t.test('a Bot chat\'s uploads are the reader\'s own, in the Bot\'s workspace only', async () => {
    const bot = await seedBot(pool, workspace.id, owner)
    const elsewhere = await seedBot(pool, other.id, owner)
    const file = async (userId: string, botId: string, name: string) => {
      const id = randomUUID()
      await pool.query(`INSERT INTO chat_attachments (id,"userId","botId",name,"mediaType",size,state,sha256,"inlineData","usedAt")
        VALUES ($1,$2,$3,$4,'image/png',2048,'ready',repeat('b',64),'\\x00',now())`, [id, userId, botId, name])
      return id
    }
    const mine = await file(owner, bot, 'screen.png')
    await file(teammate, bot, 'theirs.png')
    assert.deepEqual((await readBotChatUploads(pool, { ownerId: owner, workspaceId: workspace.id, botId: bot }))?.map(upload => upload.id), [mine])
    assert.deepEqual(await readBotChatUploads(pool, { ownerId: outsider, workspaceId: workspace.id, botId: bot }), [], 'nothing of anyone else')
    assert.equal(await readBotChatUploads(pool, { ownerId: owner, workspaceId: workspace.id, botId: elsewhere }), null, 'a Bot of another workspace')
    assert.equal(await readBotChatUploads(pool, { ownerId: owner, workspaceId: other.id, botId: bot }), null, 'the Bot read from another workspace')
  })
})
