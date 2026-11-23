// Epic #3076 local integration proof #2 (not a CI test): the REAL MCP worker
// route (app/api/mcp/route.ts POST handler) over a minted mkw_ run token.
// This exercises verifyRunToken -> worker tool dispatch -> delegateSubagent ->
// acceptLocalRun -> runPrStatus through the same code the daemon's proxied
// `mikka` MCP server calls inside a run. No mocks except the fixture rows.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { seedFixtureWorkspace } from './helpers/task-workspace'

const { pool } = await import('../lib/db')
const { issueRunToken } = await import('../lib/mcp/worker')
const { freezeWorkerDefinition } = await import('../lib/agent-kit/worker')
const { POST } = await import('../app/api/mcp/route')
const requestContext = await import('../apps/api/src/context')

const userId = `delegation-http-${randomUUID()}`
const ids = { workspaceId: randomUUID(), deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), issueId: randomUUID(), parent: randomUUID() }
const remoteKey = 'v2/github.com/mikka-ci/delegation-http'
const remoteUrl = `https://${remoteKey.slice(3)}.git`
const out: Record<string, unknown> = {}
let failed: unknown = null
let rpcId = 0
const call = async (token: string, method: string, params: Record<string, unknown>) => {
  const request = new Request('http://127.0.0.1/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const scope = requestContext.createRequestScope(request)
  const response = await requestContext.runRequestScope(scope, () => POST(request))
  await scope.after.finish()
  const text = await response.text()
  // StreamableHTTP may answer SSE frames; take the last data: payload.
  const sse = [...text.matchAll(/^data: (.*)$/gm)].map(m => m[1]).at(-1)
  const payload = sse ?? text
  let body: unknown = null
  try { body = payload ? JSON.parse(payload) : null } catch { body = { raw: String(payload).slice(0, 500) } }
  return { status: response.status, body }
}
const toolCall = (token: string, name: string, args: Record<string, unknown>) =>
  call(token, 'tools/call', { name, arguments: args })
try {
  await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  await seedFixtureWorkspace(pool, userId, 'personal', ids.workspaceId)
  const harnesses = JSON.stringify([{ harness: 'codex', installed: true }])
  await pool.query('insert into devices (id,"ownerId",name,kind,enabled,harnesses) values ($1,$2,\'Http Computer\',\'local\',true,$3)', [ids.deviceId, userId, harnesses])
  await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',\'codex http\')', [ids.agentId, userId, ids.deviceId])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,null)', [ids.repoId, ids.deviceId, userId, remoteKey, remoteUrl])
  await pool.query(`insert into issues (id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) values ($1,$2,$3,'bound','personal','Delegate http task','{"type":"doc"}','doing','normal')`, [ids.issueId, userId, ids.workspaceId])
  const parentDefinition = JSON.stringify(freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'parent brief', parent: null, executionId: null, model: 'codex-test-model' }))
  await pool.query(`insert into agent_runs (id,"userId","issueId","workspaceId","agentId","deviceId","deviceRepoId",status,kind,prompt,"agentDefinition","leaseExpiresAt")
    values ($1,$2,$3,$4,$5,$6,$7,'running','implement','task',$8,now()+interval '15 minutes')`, [ids.parent, userId, ids.issueId, ids.workspaceId, ids.agentId, ids.deviceId, ids.repoId, parentDefinition])
  const { token } = await issueRunToken({ id: ids.parent, userId })
  out.tokenPrefix = token.slice(0, 4)

  // A wrong token is refused by the real auth gate before any tool runs.
  const denied = await call('mkw_wrong_wrong_wrong_wrong_wrong', 'tools/list', {})
  out.unauthorized = { status: denied.status }
  assert.equal(denied.status, 401)

  // Tool discovery through the worker handler must offer the new tools.
  const listed = await call(token, 'tools/list', {})
  const names = ((listed.body?.result?.tools ?? []) as { name: string }[]).map(t => t.name)
  out.workerTools = names.filter(n => /delegate|pr_status|list_runs|get_run|report|submit/.test(n))
  assert.ok(names.includes('delegate_subagent'), `delegate_subagent missing: ${names}`)
  assert.ok(names.includes('pr_status'), `pr_status missing: ${names}`)

  // The real call: parent delegates through the HTTP tool.
  const delegated = await toolCall(token, 'delegate_subagent', { task: 'http-level bounded child', requestKey: 'http-k1' })
  const content = delegated.body?.result?.content?.[0]?.text
  let parsed: any = delegated.body
  try { parsed = content ? JSON.parse(content) : delegated.body } catch { parsed = { rawText: String(content).slice(0, 400) } }
  out.delegated = { status: delegated.status, parsed }
  assert.ok(parsed.childRunId, `expected childRunId, got ${JSON.stringify(parsed)}`)
  const childId = parsed.childRunId as string

  // And its sibling refusal comes back as a tool error payload, not a crash.
  const refused = await toolCall(token, 'delegate_subagent', { task: 'another concurrent child', requestKey: 'http-k2' })
  const refusedText = refused.body?.result?.content?.[0]?.text
  out.siblingRefusal = { status: refused.status, isError: refused.body?.result?.isError, parsed: refusedText ? JSON.parse(refusedText) : refused.body }
  assert.equal(JSON.parse(refusedText!).error, 'delegated_child_active')

  // pr_status over the same channel reports the server-recorded state.
  const status = await toolCall(token, 'pr_status', {})
  const statusText = status.body?.result?.content?.[0]?.text
  out.prStatus = statusText ? JSON.parse(statusText) : status.body
  assert.equal((out.prStatus as { issueId?: string }).issueId, ids.issueId)
  assert.ok(childId)
} catch (error) { failed = error } finally {
  await pool.query('DELETE FROM run_tokens WHERE "userId"=$1', [userId])
  await pool.query('DELETE FROM run_publications WHERE "userId"=$1', [userId])
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
console.log('EPIC3076 MCP HTTP WORKER LOOP: all steps passed')
