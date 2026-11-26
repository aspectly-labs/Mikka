import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import type { PullWakeEvent } from './pull-request-wake-event'

test('an undecided GitHub conflict uses bounded workflow retries and the existing thread receipt', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl })
  const owner = await seedUser(database, 'conflict-wake')
  const { id: workspaceId } = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }])
  const issueId = await seedIssue(database, owner, workspaceId)
  const agentId = await seedAgent(database, owner)
  const runId = await seedRun(database, { userId: owner, agentId, issueId, workspaceId, status: 'running' })
  const number = 7, repository = 'fixture/' + randomUUID(), repositoryId = 91, installationId = 11
  const head = 'b'.repeat(40), before = 'a'.repeat(40), url = `https://github.com/${repository}/pull/${number}`
  await database.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
    VALUES ($1,$2,$3,$4,$5,'published',$6)`, [runId, owner, issueId, `https://github.com/${repository}`, `v2/github.com/${repository}`, { url, state: 'open', headSha: before }])
  await database.query(`INSERT INTO workspace_setting_values ("workspaceId",key,"booleanValue") VALUES ($1,'prWakeOnConflict',true)`, [workspaceId])

  const scheduled: (() => Promise<unknown>)[] = []
  const delays: string[] = []
  let pendingChecks = 1, checks = 0
  const workflow = await import('workflow')
  const workflowApi = await import('workflow/api')
  t.mock.module('workflow', { namedExports: { ...workflow, sleep: async (delay: string) => { delays.push(delay) } } })
  t.mock.module('workflow/api', { namedExports: { ...workflowApi,
    start: async (work: (event: PullWakeEvent, key: string) => Promise<unknown>, args: [PullWakeEvent, string]) => {
      scheduled.push(() => work(...args))
    },
  } })
  t.mock.module('./user-access', { namedExports: {
    authorizedPullWake: async (userId: string, repo: string, repoId: number, appId: number, conflict: { number: number; head: string }) => {
      assert.deepEqual([userId, repo, repoId, appId, conflict], [owner, repository, repositoryId, installationId, { head, number }])
      checks++
      return pendingChecks-- > 0 ? null : true
    },
  } })
  const [{ dispatchVerifiedGitHubWebhook }, { pool }, { workspacePool }, { coordinatorWakeTransport }] = await Promise.all([
    import('./webhook-dispatch'), import('../db'), import('../workspace-db'), import('../coordinator/wake-after-commit'),
  ])
  const previousWake = coordinatorWakeTransport.wake
  coordinatorWakeTransport.wake = async () => undefined
  t.after(async () => {
    coordinatorWakeTransport.wake = previousWake
    await Promise.all([database.end(), pool.end(), workspacePool.end()])
  })

  const payload = {
    action: 'synchronize', before, after: head, sender: { type: 'Bot' }, installation: { id: installationId }, repository: { id: repositoryId, full_name: repository },
    pull_request: { number, state: 'open', title: 'Fixture pull request', draft: false, merged_at: null, html_url: url,
      head: { sha: head, ref: 'thread' }, mergeable: null, updated_at: new Date().toISOString() },
  }
  const send = (deliveryId: string) => dispatchVerifiedGitHubWebhook('pull_request', JSON.stringify(payload), { deliveryId })
  const messageCount = async () => Number((await database.query('SELECT count(*) FROM run_messages WHERE "runId"=$1', [runId])).rows[0].count)
  const deliveryId = randomUUID()
  assert.equal((await send(deliveryId)).status, 202)
  assert.equal(checks, 1, 'an eligible PR is checked before scheduling a recheck')
  assert.equal((await database.query('SELECT "pullRequest" FROM run_publications WHERE "runId"=$1', [runId])).rows[0].pullRequest.headSha, head)
  assert.equal(await messageCount(), 0)

  await scheduled.shift()!()
  assert.deepEqual(delays, ['3s'])
  assert.equal(checks, 2)
  assert.equal(await messageCount(), 1)

  pendingChecks = 1
  assert.equal((await send(deliveryId)).status, 202)
  await scheduled.shift()!()
  assert.equal(await messageCount(), 1, 'redelivery reuses the thread submission receipt')

  pendingChecks = 10
  delays.length = 0
  assert.equal((await send(randomUUID())).status, 202)
  await scheduled.shift()!()
  assert.deepEqual(delays, ['3s', '10s', '30s'])
  assert.equal(await messageCount(), 1, 'unknown mergeability cannot wake a thread')

  const beforeStale = checks
  assert.equal((await send(randomUUID())).status, 202)
  await database.query(`UPDATE run_publications SET "pullRequest"="pullRequest"||jsonb_build_object('headSha',$2::text) WHERE "runId"=$1`, [runId, 'c'.repeat(40)])
  await scheduled.shift()!()
  assert.equal(checks, beforeStale + 1, 'a stale publication head cannot reach another provider check')
  assert.equal(await messageCount(), 1)
})
