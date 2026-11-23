// Epic #3076 local integration proof (not a CI test): drive the real
// delegate_subagent -> queueDelegatedRun -> acceptLocalRun -> claim ->
// pr_status path against the loopback e2e database, exactly as the MCP
// worker route executes it (the route only adds bearer-token auth first).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { seedFixtureWorkspace } from './helpers/task-workspace'

const { pool } = await import('../lib/db')
const { delegateSubagent } = await import('../lib/mcp/run-delegation')
const { runPrStatus } = await import('../lib/mcp/run-pr-status')
const { claimLocalRun } = await import('../lib/computer/claim')
const { freezeWorkerDefinition } = await import('../lib/agent-kit/worker')

const userId = `delegation-loop-${randomUUID()}`
const ids = { workspaceId: randomUUID(), deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), issueId: randomUUID(), parent: randomUUID() }
const remoteKey = 'v2/github.com/mikka-ci/delegation-loop'
const remoteUrl = `https://${remoteKey.slice(3)}.git`
const out: Record<string, unknown> = {}
let failed: unknown = null
try {
  await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  await seedFixtureWorkspace(pool, userId, 'personal', ids.workspaceId)
  const harnesses = JSON.stringify([{ harness: 'codex', installed: true }])
  await pool.query('insert into devices (id,"ownerId",name,kind,enabled,harnesses) values ($1,$2,\'Loop Computer\',\'local\',true,$3)', [ids.deviceId, userId, harnesses])
  await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',\'codex loop\')', [ids.agentId, userId, ids.deviceId])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,null)', [ids.repoId, ids.deviceId, userId, remoteKey, remoteUrl])
  await pool.query(`insert into issues (id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) values ($1,$2,$3,'bound','personal','Delegate loop task','{"type":"doc"}','doing','normal')`, [ids.issueId, userId, ids.workspaceId])
  // The parent is a real live run frozen on a model like a dispatched run would be.
  const parentDefinition = JSON.stringify(freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'parent brief', parent: null, executionId: null, model: 'codex-test-model' }))
  await pool.query(`insert into agent_runs (id,"userId","issueId","workspaceId","agentId","deviceId","deviceRepoId",status,kind,prompt,"agentDefinition")
    values ($1,$2,$3,$4,$5,$6,$7,'running','implement','task',$8)`, [ids.parent, userId, ids.issueId, ids.workspaceId, ids.agentId, ids.deviceId, ids.repoId, parentDefinition])
  const parentRun = { id: ids.parent, userId, issueId: ids.issueId }

  // 1. The worker tool queues the bounded child through the real admission path.
  const first = await delegateSubagent(parentRun, { task: 'verify the delegation seam end to end', requestKey: 'loop-k1' })
  out.firstCall = first
  assert.ok((first as { childRunId?: string }).childRunId, `expected childRunId, got ${JSON.stringify(first)}`)
  const childId = (first as { childRunId: string }).childRunId

  const [child] = (await pool.query(`select status,kind,prompt,"agentDefinition"->'delegation'->>'parentRunId' as parent, "agentDefinition"->>'model' as model from agent_runs where id=$1`, [childId])).rows
  out.childRow = { status: child.status, kind: child.kind, parent: child.parent, model: child.model, promptTail: String(child.prompt).slice(-80) }
  assert.equal(child.status, 'queued')
  assert.equal(child.parent, ids.parent)
  assert.equal(child.model, 'codex-test-model')
  assert.match(String(child.prompt), /verify the delegation seam/)

  // 2. Same requestKey replays to the same child; a new key is the live-sibling refusal.
  const replay = await delegateSubagent(parentRun, { task: 'verify the delegation seam end to end', requestKey: 'loop-k1' })
  out.replay = replay
  assert.equal((replay as { childRunId?: string }).childRunId, childId)
  assert.equal((replay as { replayed?: boolean }).replayed, true)
  const second = await delegateSubagent(parentRun, { task: 'a second concurrent child', requestKey: 'loop-k2' })
  out.siblingRefusal = second
  assert.equal((second as { error?: string }).error, 'delegated_child_active')

  // 3. A delegated child may never delegate (no-grandchild rule through the tool).
  const grandchild = await delegateSubagent({ id: childId, userId, issueId: ids.issueId }, { task: 'nested', requestKey: 'loop-g1' })
  out.grandchildRefusal = grandchild
  assert.equal((grandchild as { error?: string }).error, 'delegation_unavailable')
  const badInput = await delegateSubagent(parentRun, { task: '', requestKey: 'loop-bad' })
  out.badInputRefusal = badInput
  assert.equal((badInput as { error?: string }).error, 'delegation_unavailable')

  // 4. The daemon's own claim path takes the queued child onto the device.
  const claim = await claimLocalRun(pool, childId, ids.deviceId, new Date(Date.now() + 15 * 60_000))
  out.claim = claim
  const [claimed] = (await pool.query('select status from agent_runs where id=$1', [childId])).rows
  out.claimedStatus = claimed?.status

  // 5. pr_status returns the server's structured state for the claimed child.
  const status = await runPrStatus({ id: childId, userId, issueId: ids.issueId })
  out.prStatus = status
  assert.equal(status.issueId, ids.issueId)
  assert.equal(status.pullRequest, null)
  assert.equal(status.checks, null)

  // 6. Once the child settles, the live parent may delegate one more child.
  await pool.query(`update agent_runs set status='completed' where id=$1`, [childId])
  const next = await delegateSubagent(parentRun, { task: 'second child after the first settled', requestKey: 'loop-k3' })
  out.afterSettled = next
  assert.ok((next as { childRunId?: string }).childRunId, `expected a new childRunId, got ${JSON.stringify(next)}`)
  assert.notEqual((next as { childRunId?: string }).childRunId, childId)

  // 7. When the parent itself ends, no delegation is possible at all.
  await pool.query(`update agent_runs set status='completed' where id=$1`, [ids.parent])
  const orphan = await delegateSubagent(parentRun, { task: 'parent finished', requestKey: 'loop-k4' })
  out.parentEndedRefusal = orphan
  assert.equal((orphan as { error?: string }).error, 'delegation_unavailable')
} catch (error) { failed = error } finally {
  await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM issues WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM device_repos WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM agents WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [userId])
  await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
  await pool.end()
}
console.log(JSON.stringify(out, null, 2))
if (failed) { console.error('FAILED:', failed); process.exit(1) }
console.log('EPIC3076 DELEGATION LOOP: all steps passed')
