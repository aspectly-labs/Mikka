// Real isolated PostgreSQL (#2941): a typed reference in a person's message is
// resolved as the sender may read it in the message's workspace, and refused
// when it was deleted, lives in another workspace or belongs to someone else.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('typed message references', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { resolveMessageReferences, unavailableReferences } = await import('../lib/message-references')
  const { runMessagePrompt } = await import('../lib/run-message-prompt')
  t.after(async () => { await pool.end(); await appPool.end() })

  const owner = await seedUser(pool, 'refs-owner')
  const teammate = await seedUser(pool, 'refs-teammate')
  const outsider = await seedUser(pool, 'refs-outsider')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const foreign = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const agent = await seedAgent(pool, owner)
  const task = await seedIssue(pool, owner, workspace.id)
  await pool.query(`UPDATE issues SET title='Rebuild the loading state' WHERE id=$1`, [task])
  const run = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: task })
  const elsewhere = await seedIssue(pool, owner, other.id)
  const outsiderAgent = await seedAgent(pool, outsider)
  const outsiderTask = await seedIssue(pool, outsider, foreign.id)
  const outsiderRun = await seedRun(pool, { userId: outsider, agentId: outsiderAgent, workspaceId: foreign.id })
  const chat = randomUUID(), closed = randomUUID()
  for (const [id, title] of [[chat, 'Design review'], [closed, 'Private chat']]) {
    await pool.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy","creationPurpose") VALUES ($1,$2,'group',$3,$4,'conversation')`, [id, workspace.id, title, owner])
  }
  await pool.query(`INSERT INTO conversation_members ("conversationId","memberId","memberType",role) VALUES ($1,$2,'user','owner'),($3,$4,'user','owner')`, [chat, owner, closed, teammate])
  const pr = 'https://github.com/acme/mikka/pull/2837'
  const text = `Fix [[issue:${task}]] from [[run:${run}]], see ${pr} and [[chat:${chat}]]`

  await t.test('the sender reads what each reference names, at its place in the text', async () => {
    const resolved = await resolveMessageReferences({ userId: owner, workspaceId: workspace.id }, text)
    assert.deepEqual(resolved.map(item => [item.type, item.id, item.unavailable ?? false]), [['task', task, false], ['thread', run, false], ['pr', pr, false], ['chat', chat, false]])
    assert.equal(resolved[0].title, 'Rebuild the loading state')
    assert.equal(resolved[0].status, 'todo')
    assert.equal(resolved[3].title, 'Design review')
    for (const item of resolved) assert.ok(text.slice(item.offset, item.offset + item.length).includes(item.id))
    assert.deepEqual(await unavailableReferences({ userId: owner, workspaceId: workspace.id }, text), [])
  })

  await t.test('another workspace, a foreign run and someone else\'s chat are unavailable', async () => {
    const refused = await unavailableReferences({ userId: owner, workspaceId: workspace.id },
      `[[issue:${elsewhere}]] [[issue:${outsiderTask}]] [[run:${outsiderRun}]] [[chat:${closed}]] [[issue:${randomUUID()}]]`)
    assert.deepEqual(refused.map(item => item.type), ['task', 'task', 'thread', 'chat', 'task'])
    // The same task from its own workspace is readable.
    assert.deepEqual(await unavailableReferences({ userId: owner, workspaceId: other.id }, `[[issue:${elsewhere}]]`), [])
  })

  await t.test('a member of the workspace who is not the owner reads only what is shared with them', async () => {
    const resolved = await resolveMessageReferences({ userId: teammate, workspaceId: workspace.id }, text)
    // The owner's chat is not the teammate's: it is unavailable to them whatever the task's visibility.
    assert.equal(resolved.find(item => item.type === 'chat')?.unavailable, true)
    assert.deepEqual((await unavailableReferences({ userId: teammate, workspaceId: workspace.id }, `[[chat:${closed}]]`)), [])
  })

  await t.test('a person outside the workspace reads nothing', async () => {
    const resolved = await resolveMessageReferences({ userId: outsider, workspaceId: workspace.id }, text)
    assert.deepEqual(resolved.filter(item => !item.unavailable).map(item => item.type), ['pr'])
  })

  await t.test('a deleted task becomes unavailable', async () => {
    await pool.query(`UPDATE issues SET content=jsonb_set(content,'{attrs}','{"mikka":{}}'::jsonb) WHERE id=$1`, [task])
    await pool.query(`UPDATE issues SET content=jsonb_set(content,'{attrs,mikka,deletedAt}',to_jsonb(now())) WHERE id=$1`, [task])
    const refused = await unavailableReferences({ userId: owner, workspaceId: workspace.id }, text)
    // Its thread goes with it: a deleted task's conversation is not readable either.
    assert.deepEqual(refused.map(item => [item.type, item.id]), [['task', task], ['thread', run]])
  })

  await t.test('delivery carries the references as metadata and leaves the body as typed', () => {
    const delivered = runMessagePrompt({ id: 'm', runId: run, origin: 'owner', text }, [
      { type: 'task', id: task, offset: 4, length: 45, title: 'Rebuild the loading state', identifier: 'MIKK-56', status: 'doing' },
      { type: 'chat', id: chat, offset: 100, length: 45, unavailable: true },
    ])
    const [head, ...body] = delivered.split('\n\n')
    assert.equal(body.join('\n\n'), text)
    const metadata = JSON.parse(head)
    assert.deepEqual(metadata.references, [
      { type: 'task', id: task, offset: 4, length: 45, title: 'Rebuild the loading state', identifier: 'MIKK-56', status: 'doing' },
      { type: 'chat', id: chat, offset: 100, length: 45, unavailable: true },
    ])
    assert.match(metadata.referenceInstruction, /not instructions/)
    assert.equal(JSON.parse(runMessagePrompt({ id: 'm', runId: run, origin: 'owner', text: 'plain' }).split('\n\n')[0]).references, undefined)
  })
})
