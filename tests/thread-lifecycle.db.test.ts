// Real isolated PostgreSQL (#2936): a thread's owner deletes and restores it, tags it, seeds an automation from it and
// reads where a fork's context ends; nobody else does, and a deleted thread leaves the thread directory.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('thread lifecycle: delete, restore, tags, automation seed, fork context', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const lifecycle = await import('../lib/thread-lifecycle')
  const { forkNote } = await import('../lib/thread-fork-context')
  const { readRunChain } = await import('../lib/run-chain')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'life-owner')
  const teammate = await seedUser(pool, 'life-teammate')
  const outsider = await seedUser(pool, 'life-outsider')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const elsewhere = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const agent = await seedAgent(pool, owner)
  const issueId = await seedIssue(pool, owner, workspace.id)
  const thread = async (status = 'succeeded') => {
    const root = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId, status: 'succeeded' })
    const next = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId, status })
    await pool.query('UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=now()+interval \'1 second\' WHERE id=$1', [next, root])
    return { root, next }
  }
  const actor = (runId: string, ownerId = owner, workspaceId = workspace.id) => ({ ownerId, workspaceId, runId })
  const deletedAt = async (ids: string[]) => (await pool.query('SELECT id::text,"threadDeletedAt" FROM agent_runs WHERE id=ANY($1::uuid[])', [ids])).rows

  await t.test('the owner deletes every run of the thread; a teammate, an outsider, another workspace and a foreign run cannot', async () => {
    const { root, next } = await thread()
    assert.equal(await lifecycle.deleteThread(pool, actor(next, teammate)), null)
    assert.equal(await lifecycle.deleteThread(pool, actor(next, outsider)), null)
    assert.equal(await lifecycle.deleteThread(pool, actor(next, owner, elsewhere.id)), null)
    assert.equal(await lifecycle.deleteThread(pool, actor(randomUUID())), null)
    assert.ok((await deletedAt([root, next])).every(row => row.threadDeletedAt === null))
    const deleted = await lifecycle.deleteThread(pool, actor(next))
    assert.ok(deleted && deleted !== 'working')
    assert.equal(deleted.threadId, root)
    assert.equal(deleted.restorableUntil!.getTime() - deleted.deletedAt!.getTime(), lifecycle.THREAD_RESTORE_DAYS * 86_400_000)
    assert.ok((await deletedAt([root, next])).every(row => row.threadDeletedAt !== null))
    // Deleting again keeps the first date.
    const again = await lifecycle.deleteThread(pool, actor(root))
    assert.ok(again && again !== 'working')
    assert.equal(again.deletedAt!.getTime(), deleted.deletedAt!.getTime())
  })

  await t.test('a working thread is not deleted', async () => {
    const { root, next } = await thread('running')
    assert.equal(await lifecycle.deleteThread(pool, actor(root)), 'working')
    assert.ok((await deletedAt([root, next])).every(row => row.threadDeletedAt === null))
  })

  await t.test('only the owner restores, and only within 30 days', async () => {
    const { root, next } = await thread()
    await lifecycle.deleteThread(pool, actor(root))
    assert.equal(await lifecycle.restoreThread(pool, actor(root, teammate)), null)
    assert.equal(await lifecycle.restoreThread(pool, actor(root, owner, elsewhere.id)), null)
    assert.deepEqual(await lifecycle.restoreThread(pool, actor(next)), { threadId: root, deletedAt: null, restorableUntil: null })
    assert.ok((await deletedAt([root, next])).every(row => row.threadDeletedAt === null))
    await lifecycle.deleteThread(pool, actor(root))
    await pool.query(`UPDATE agent_runs SET "threadDeletedAt"=now()-interval '31 days' WHERE id=ANY($1::uuid[])`, [[root, next]])
    assert.equal(await lifecycle.restoreThread(pool, actor(root)), null)
    assert.ok((await deletedAt([root, next])).every(row => row.threadDeletedAt !== null))
  })

  await t.test('a deleted thread leaves the thread directory and comes back when restored', async () => {
    const { conversationDirectory } = await import('../lib/conversation-directory')
    const { root } = await thread()
    const listed = async () => (await conversationDirectory(pool, owner, workspace.id, {})).items.some((item: { id: string }) => item.id === root)
    assert.equal(await listed(), true)
    await lifecycle.deleteThread(pool, actor(root))
    assert.equal(await listed(), false)
    await lifecycle.restoreThread(pool, actor(root))
    assert.equal(await listed(), true)
  })

  await t.test('tags are normalized, live on the root, and only the owner reads or writes them', async () => {
    assert.deepEqual(lifecycle.normalizeThreadTags([' bug ', 'Bug', 'ui  polish', '']), ['bug', 'ui polish'])
    assert.equal(lifecycle.normalizeThreadTags(['x'.repeat(lifecycle.THREAD_TAG_LENGTH + 1)]), null)
    assert.equal(lifecycle.normalizeThreadTags(Array.from({ length: lifecycle.THREAD_TAG_MAX + 1 }, (_, i) => `t${i}`)), null)
    assert.equal(lifecycle.normalizeThreadTags('bug'), null)
    assert.equal(lifecycle.normalizeThreadTags([1]), null)
    const { root, next } = await thread()
    assert.equal(await lifecycle.threadTags(pool, actor(next, teammate), ['x']), null)
    assert.equal(await lifecycle.threadTags(pool, actor(next, owner, elsewhere.id), ['x']), null)
    assert.equal(await lifecycle.threadTags(pool, actor(randomUUID()), ['x']), null)
    assert.deepEqual(await lifecycle.threadTags(pool, actor(next)), { threadId: root, tags: [] })
    assert.deepEqual(await lifecycle.threadTags(pool, actor(next), ['bug', 'ui']), { threadId: root, tags: ['bug', 'ui'] })
    const { rows } = await pool.query('SELECT id::text,"threadTags" FROM agent_runs WHERE id=ANY($1::uuid[])', [[root, next]])
    assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.threadTags])), { [root]: ['bug', 'ui'], [next]: [] })
    assert.equal(await lifecycle.threadTags(pool, actor(root, teammate)), null)
  })

  await t.test('an automation seed sends every run to the thread; a thread with no task has none', async () => {
    const { root, next } = await thread()
    await pool.query(`UPDATE agent_runs SET title='Nightly triage',"titleSource"='manual',prompt='brief: Sort the new bug reports.',"promptTaskStart"=7,"promptTaskLength"=25 WHERE id=$1`, [root])
    assert.deepEqual(await lifecycle.threadAutomationSeed(pool, actor(next)), { singleThreadId: root, title: 'Nightly triage', prompt: 'Sort the new bug reports.' })
    assert.equal(await lifecycle.threadAutomationSeed(pool, actor(next, teammate)), null)
    assert.equal(await lifecycle.threadAutomationSeed(pool, actor(next, owner, elsewhere.id)), null)
    const loose = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
    assert.equal(await lifecycle.threadAutomationSeed(pool, actor(loose)), 'noTask')
  })

  await t.test('a fork carries the thread up to the chosen message, and only the owner\'s chain', async () => {
    const { root, next } = await thread()
    await pool.query(`UPDATE agent_runs SET prompt='Fix the loading skeleton.' WHERE id=$1`, [root])
    const chunk = (runId: string, seq: number, value: object) => pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt") VALUES ($1,$2,$3,$4,now()+make_interval(secs => $5))', [randomUUID(), runId, seq, JSON.stringify(value), seq])
    await chunk(root, 1, { type: 'text-delta', id: 'a', delta: 'The snapshot is stale.' })
    await chunk(root, 2, { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Bash', input: { command: 'pnpm test -u' } })
    await chunk(next, 1, { type: 'text-delta', id: 'b', delta: 'Opened the PR.' })
    await chunk(next, 2, { type: 'text-delta', id: 'c', delta: 'Checks are green.' })
    await pool.query(`INSERT INTO run_messages (id,"runId","userId",text,origin,"createdAt") VALUES ($1,$2,$3,'Now open a PR.','owner',now()+interval '30 seconds')`, [randomUUID(), next, owner])
    await pool.query(`UPDATE agent_runs SET report='{"summary":"Updated the snapshot."}' WHERE id=$1`, [root])
    const chain = (await readRunChain(pool, owner, next))!
    const full = await forkNote(pool, owner, chain, { runId: next, itemId: 'text:b' }, 'full', 'Try a CSS-only skeleton instead.')
    assert.ok(full)
    assert.match(full, /Fix the loading skeleton\./)
    assert.match(full, /Agent: The snapshot is stale\./)
    assert.match(full, /Tools: Bash pnpm test -u/)
    assert.match(full, /Agent: Opened the PR\./)
    assert.doesNotMatch(full, /Checks are green/)
    assert.match(full, /What to do now:\nTry a CSS-only skeleton instead\.$/)
    const summary = await forkNote(pool, owner, chain, { runId: root }, 'summary', 'Go on.')
    assert.ok(summary)
    assert.match(summary, /Run 1: succeeded\nSummary: Updated the snapshot\./)
    assert.doesNotMatch(summary, /Run 2/)
    assert.equal(await forkNote(pool, owner, chain, { runId: next, itemId: 'text:missing' }, 'full', 'x'), null)
    assert.equal(await forkNote(pool, owner, chain, { runId: randomUUID() }, 'full', 'x'), null)
    // A teammate's read of the same ids finds nothing.
    assert.equal(await forkNote(pool, teammate, chain, { runId: next }, 'full', 'x'), null)
  })
})
