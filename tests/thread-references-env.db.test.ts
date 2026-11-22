// #2941: typed references resolve against the owner's workspace — a deleted or
// out-of-scope reference comes back broken; the expansion prepends context.
// Thread-scoped env vars encrypt at rest, never read back a value through the
// metadata path, and decrypt into the claim's runtime secrets.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('thread references + thread env vars', { skip: !dbUrl }, async t => {
  const savedKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  t.after(() => { if (savedKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = savedKey })

  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl })
  t.after(() => pool.end())
  const { resolveThreadReferences, expandReferences } = await import('../lib/thread-references-server')
  const { setThreadScopeSecret, deleteThreadScopeSecret } = await import('../lib/secrets/thread-scope')
  const { loadTaskRuntimeSecrets } = await import('../lib/secrets/runtime')

  const owner = await seedUser(pool, 'ref-owner')
  const other = await seedUser(pool, 'ref-other')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const otherWorkspace = await seedWorkspace(pool, other, [{ userId: other, role: 'admin' }])
  const agent = await seedAgent(pool, owner)
  const issue = await seedIssue(pool, owner, workspace)
  const foreignIssue = await seedIssue(pool, other, otherWorkspace)
  const runId = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace, issueId: issue })
  const bot = await seedBot(pool, workspace, owner)

  const resolved = await resolveThreadReferences(pool, owner, workspace, [
    { type: 'task', id: issue },
    { type: 'task', id: foreignIssue },
    { type: 'task', id: randomUUID() },
    { type: 'bot', id: bot },
    { type: 'thread', id: runId },
    { type: 'thread', id: randomUUID() },
  ])
  assert.equal(resolved[0].state, 'ok')
  assert.equal(resolved[1].state, 'broken', 'a task in another workspace must not resolve')
  assert.equal(resolved[2].state, 'broken')
  assert.equal(resolved[3].state, 'ok')
  assert.equal(resolved[4].state, 'ok')
  assert.equal(resolved[5].state, 'broken')
  const expanded = expandReferences(resolved)
  assert.match(expanded, /<references>/)
  assert.match(expanded, /\[bot\]/)

  // Thread-scoped env var: stored encrypted, metadata returns names only,
  // runtime secrets decrypt for the matching thread scope ref.
  await setThreadScopeSecret(owner, workspace, runId, { name: 'THREAD_TOKEN', value: 'secret-value-1' })
  const { rows } = await pool.query(`SELECT name,note,ciphertext FROM workspace_secrets WHERE "scopeType"='thread' AND "scopeRef"=$1`, [runId])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'THREAD_TOKEN')
  assert.notEqual(rows[0].ciphertext, 'secret-value-1', 'value must be encrypted at rest')
  const runtime = await loadTaskRuntimeSecrets(workspace, null, process.env, owner, runId)
  const found = runtime.find(r => r.name === 'THREAD_TOKEN')
  assert.equal(found?.value, 'secret-value-1', 'claim-side runtime decrypts the thread var')
  // A different run id must not see the var.
  const otherRun = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace, issueId: issue })
  const otherRuntime = await loadTaskRuntimeSecrets(workspace, null, process.env, owner, otherRun)
  assert.equal(otherRuntime.find(r => r.name === 'THREAD_TOKEN'), undefined)
  await deleteThreadScopeSecret(owner, workspace, runId, 'THREAD_TOKEN')
  const { rows: gone } = await pool.query(`SELECT id FROM workspace_secrets WHERE "scopeType"='thread' AND "scopeRef"=$1`, [runId])
  assert.equal(gone.length, 0)
})
