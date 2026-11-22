// #3083: the internal CI receipt is idempotent at the API boundary. A replayed
// workflow result never wakes the owning Bot's run twice; while the stored
// event is still undelivered a redelivery resends that same event id (Eve's
// idempotency key is mikka-event:<id>), and after delivery a replay is a full
// no-op. Out-of-order attempts and foreign targets cannot touch the latest
// authorized result.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { githubFixture } from '../../tests/fakes/github-fixture.mjs'

const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('CI workflow-result acceptance tests require matching isolated loopback _e2e URLs')

const sends: Array<{ scope: { ownerId: string; workspaceId: string; botId: string | null; surface: string }; eventId: string }> = []
mock.module(new URL('../eve/server-client.ts', import.meta.url).href, { namedExports: {
  sendEveEvent: async (scope: { ownerId: string; workspaceId: string; botId: string | null; surface: string }, eventId: string) => {
    sends.push({ scope, eventId })
    return { sessionId: 'fixture-session', deliveryId: 'fixture-delivery' }
  },
} })
test('a redelivered workflow result wakes the owning run once and stays a no-op after delivery', { skip: !valid, timeout: 120_000 }, async t => {
  // The live repository credential is the real GitHub read the hosted receiver
  // repeats per delivery, answered by the shared fake GitHub HTTP service: one
  // App installation (99) reaching mikka-e2e/core-loop (789) for the person's
  // own synthetic GitHub user token. Suspending the installation stales the grant.
  const github = await githubFixture()
  t.after(() => github.close())
  const appId = process.env.GITHUB_APP_ID
  process.env.GITHUB_APP_ID = '123'
  t.after(() => { if (appId === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = appId })
  const network = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new Request(input, init).url.startsWith('https://api.github.com/') ? github.fetch(input, init) : network(input, init))
  const repositoryReads = () => github.github.requests.filter((request: { method: string; path: string }) =>
    request.method === 'GET' && request.path === '/github/repos/mikka-e2e/core-loop').length
  const { pool } = await import('../db')
  const { saveGitHubConnection } = await import('./connection')
  const { acceptWorkflowResult } = await import('./workflow-result-store')
  const owner = `wfr-${randomUUID()}`, agentId = randomUUID(), botId = randomUUID(), runId = randomUUID(), issueId = randomUUID()
  const headSha = 'a'.repeat(40)
  try {
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'WF owner',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,'Coder','codex')`, [agentId, owner])
    await saveGitHubConnection(owner, { githubAccountId: '456', githubLogin: 'mvp-owner-456' }, { access_token: 'mikka-local-synthetic-user-token', expires_in: 3600 })
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,'CI fixture',$4,'review','normal')`, [issueId, owner, workspaceId, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })])
    await pool.query(`INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,'CI bot')`, [botId, owner, workspaceId])
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","workspaceId","botId","agentId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,'succeeded','CI fixture')`, [runId, owner, issueId, workspaceId, botId, agentId])
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",branch,status,"pullRequest") VALUES ($1,$2,$3,'https://github.com/mikka-e2e/core-loop','v2/github.com/mikka-e2e/core-loop','mikka/ci-7','published',$4)`, [runId, owner, issueId, JSON.stringify({ url: 'https://github.com/mikka-e2e/core-loop/pull/7', headSha })])
    await pool.query(`INSERT INTO github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") VALUES ($1,'v2/github.com/mikka-e2e/core-loop','456',99,789)`, [owner])
    const result = { version: 1 as const, deliveryId: 'delivery-1', installationId: 99, repositoryId: 789, repository: 'mikka-e2e/core-loop',
      workflowId: 33, workflowRunId: 44, attempt: 1, headSha, branch: 'mikka/ci-7', conclusion: 'failure' as const }
    const eventCount = () => pool.query<{ n: number; ids: string[] }>(`SELECT count(*)::int n, array_agg(id ORDER BY "createdAt") ids FROM coordinator_events WHERE "runId"=$1`, [runId]).then(r => r.rows[0])
    const sendsBefore = sends.length

    await acceptWorkflowResult(result)
    assert.equal(sends.length, sendsBefore + 1, 'the first accepted result wakes its owning Bot once')
    assert.deepEqual(sends.at(-1)!.scope, { ownerId: owner, workspaceId, botId, surface: 'web' })
    const first = await eventCount()
    assert.equal(first.n, 1)
    assert.equal(sends.at(-1)!.eventId, first.ids[0])
    const [row] = (await pool.query<{ dedupeKey: string; tier: string; issueId: string; payload: { source: string; deliveryId: string } }>(
      `SELECT "dedupeKey",tier,"issueId",payload FROM coordinator_events WHERE id=$1`, [first.ids[0]])).rows
    assert.equal(row.dedupeKey, `github-workflow:${runId}:99:789:33:44:1:${headSha}`)
    assert.equal(row.tier, 'result')
    assert.equal(row.issueId, issueId)
    assert.equal(row.payload.source, 'github_workflow_run')
    assert.equal(row.payload.deliveryId, 'delivery-1')
    assert.equal(repositoryReads(), 1, 'the admitted result rechecked live repository authority')
    const publication = () => pool.query<{ pullRequest: { workflowResults?: Record<string, unknown> } }>(`SELECT "pullRequest" FROM run_publications WHERE "runId"=$1`, [runId]).then(r => r.rows[0].pullRequest)
    assert.deepEqual((await publication()).workflowResults?.['33'], { headSha, run: 44, attempt: 1, conclusion: 'failure' })

    // A GitHub redelivery has a new delivery id but the same result identity:
    // while Eve has not acknowledged it, the stored event is resent under its
    // own id — never a second coordinator event.
    await acceptWorkflowResult({ ...result, deliveryId: 'delivery-2' })
    assert.equal(sends.at(-1)!.eventId, first.ids[0], 'a pending receipt resends the same event, not a new one')
    assert.equal((await eventCount()).n, 1)

    // Once the receipt is marked, the replay is a complete no-op.
    await pool.query(`UPDATE coordinator_events SET "deliveredAt"=now() WHERE "runId"=$1`, [runId])
    await acceptWorkflowResult({ ...result, deliveryId: 'delivery-3' })
    assert.equal(sends.length, sendsBefore + 2, 'a delivered result accepts without waking the Bot again')
    assert.equal((await eventCount()).n, 1)
    await acceptWorkflowResult({ ...result, conclusion: 'success' })
    assert.equal(sends.length, sendsBefore + 2, 'a conflicting outcome for the identical attempt is refused')

    // A later attempt is a new result; a replayed old attempt cannot reopen it.
    await acceptWorkflowResult({ ...result, attempt: 2, conclusion: 'success', deliveryId: 'delivery-4' })
    assert.equal(sends.length, sendsBefore + 3)
    assert.equal((await eventCount()).n, 2)
    await pool.query(`UPDATE coordinator_events SET "deliveredAt"=now() WHERE "runId"=$1`, [runId])
    await acceptWorkflowResult(result)
    assert.equal(sends.length, sendsBefore + 3, 'attempt 1 cannot overwrite attempt 2')
    assert.deepEqual((await publication()).workflowResults?.['33'], { headSha, run: 44, attempt: 2, conclusion: 'success' })

    // A delivery matching no published run never reaches authority checks or any Bot.
    const githubCalls = github.github.requests.length
    await acceptWorkflowResult({ ...result, repositoryId: 23, repository: 'other/r' })
    assert.equal(github.github.requests.length, githubCalls)
    assert.equal(sends.length, sendsBefore + 3)

    // A live credential that no longer names this installation drops the receipt.
    github.scenario.installationSuspendedAt = '2026-11-20T00:00:00Z'
    const readsBefore = repositoryReads()
    await acceptWorkflowResult({ ...result, attempt: 3, deliveryId: 'delivery-5' })
    assert.equal(sends.length, sendsBefore + 3, 'a stale installation grant suppresses the queued result')
    assert.equal(repositoryReads(), readsBefore, 'a stale grant is refused before the repository is read')
    assert.equal((await eventCount()).n, 2)
  } finally {
    await pool.query(`DELETE FROM coordinator_events WHERE "runId"=$1`, [runId])
    await pool.query(`DELETE FROM run_publications WHERE "runId"=$1`, [runId])
    await pool.query(`DELETE FROM github_repository_installations WHERE "userId"=$1`, [owner])
    await pool.query(`DELETE FROM github_connections WHERE "userId"=$1`, [owner])
    await pool.query(`DELETE FROM agent_runs WHERE id=$1`, [runId])
    await pool.query(`DELETE FROM bots WHERE id=$1`, [botId])
    await pool.query(`DELETE FROM issues WHERE id=$1`, [issueId])
    await pool.query(`DELETE FROM agents WHERE id=$1`, [agentId])
    await pool.query(`DELETE FROM mikka_workspace_members WHERE "userId"=$1`, [owner])
    await pool.query(`DELETE FROM mikka_workspaces WHERE "userId"=$1`, [owner])
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [owner])
  }
})
