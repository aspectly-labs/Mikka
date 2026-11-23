import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from './helpers/task-workspace'
import { mentionAt, personReferenceParts, referenceMarker, sourceMentionAt } from '../lib/thread-references'

test('an inline mention replaces only the active word at the caret and keeps unrelated human text literal', () => {
  const text = 'Please see @thread:checkout and the log'
  assert.deepEqual(mentionAt(text, text.indexOf(' and')), { from: 11, end: 27, kind: 'thread', query: 'checkout' })
  assert.equal(mentionAt('mail@example', 12), null)
  for (const query of ['@file', 'See @folder:', 'See @FILE:src/index.ts']) {
    assert.equal(sourceMentionAt(query, query.length), true)
    assert.equal(mentionAt(query, query.length), null)
  }
  assert.equal(sourceMentionAt('See @file:src/a.ts later', 24), false)
  assert.equal(mentionAt('@filename', 9)?.query, 'filename')
  const id = randomUUID()
  const marker = referenceMarker({ kind: 'thread', id, title: 'Checkout' })
  assert.deepEqual(personReferenceParts(`ref ${marker} ${id}`), [
    { kind: 'text', text: 'ref ' }, { kind: 'thread', id }, { kind: 'text', text: ' ' }, { kind: 'text', text: id },
  ])
  const chat = referenceMarker({ kind: 'thread', conversationKind: 'chat', id, title: 'Independent chat' })
  assert.equal(chat, `[[chat:${id}]]`)
  assert.deepEqual(personReferenceParts(`${chat} ${marker}`), [{ kind: 'chat', id }, { kind: 'text', text: ' ' }, { kind: 'thread', id }])
  assert.deepEqual(personReferenceParts('https://github.com/org/repo/pull/2'), [{ kind: 'pr', id: 'https://github.com/org/repo/pull/2' }])
  assert.equal(personReferenceParts('https://github.com.example/org/repo/pull/2')[0].kind, 'text')
})

test('reference search scopes tasks, conversation roots, and PRs to the active viewer and workspace', { skip: !disposableDatabase(), timeout: 120_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { searchThreadReferences } = await import('../lib/thread-reference-search')
  const owner = 'mention-' + randomUUID(), other = 'mention-' + randomUUID()
  const chat = randomUUID(), issue = randomUUID(), agent = randomUUID(), run = randomUUID(), url = 'https://github.com/test/mikka/pull/2259'
  let workspace = '', foreign = ''
  try {
    for (const user of [owner, other]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    workspace = await seedFixtureWorkspace(pool, owner)
    foreign = await seedFixtureWorkspace(pool, other)
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState")
      VALUES ($1,$2,'Checkout data',$3,'doing','normal',$4,'bound')`, [issue, owner, JSON.stringify({ type: 'doc', attrs: { mikka: { pullRequests: [{ url, title: 'Checkout fix', state: 'open' }] } } }), workspace])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,'Coding','codex')`, [agent, owner])
    await pool.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status,prompt,"promptTaskStart","promptTaskLength",title,"titleSource")
      VALUES ($1,$2,$3,$4,$5,'running','Checkout',0,8,'Checkout','manual')`, [run, owner, workspace, issue, agent])
    await pool.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy","creationPurpose") VALUES($1,$2,'group','Named citation',$3,'conversation')`, [chat,workspace,owner])
    await pool.query(`INSERT INTO conversation_members("conversationId","memberId","memberType",role) VALUES($1,$2,'user','owner')`, [chat,owner])
    assert.deepEqual(await searchThreadReferences(owner, workspace, 'Named citation', 'thread'), [{ kind: 'thread', conversationKind: 'chat', id: chat, title: 'Named citation' }])
    const items = await searchThreadReferences(owner, workspace, 'checkout')
    assert.deepEqual(items.map(item => [item.kind, item.id]), [['task', issue], ['thread', run], ['pr', url]])
    const { handleGroup } = await import('../lib/group-conversations-store')
    const request = { resource: 'messages' as const, id: chat, origin: 'https://mikka.test', host: 'mikka.test' }
    const membership = async (workspaceId: string, userId: string) => Boolean((await pool.query(
      `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`, [workspaceId, userId],
    )).rowCount)
    const body = items.map(referenceMarker).join(' ')
    const posted = await handleGroup(pool, membership, { ...request, userId: owner, method: 'POST',
      body: JSON.stringify({ body, mentions: [], expectedWorkspaceId: workspace, expectedOwnerId: owner }) })
    assert.equal(posted.status, 201)
    const read = await handleGroup(pool, membership, { ...request, userId: owner, method: 'GET' })
    assert.equal(read.status, 200)
    const first = (read.body as { messages: { body: string; mentions: unknown[] }[] }).messages[0]
    assert.equal(first.body, body)
    assert.deepEqual(first.mentions, [])
    assert.equal((await handleGroup(pool, membership, { ...request, userId: other, method: 'GET' })).status, 404)

    assert.deepEqual((await searchThreadReferences(owner, workspace, '#2259', 'pr')).map(item => item.id), [url])
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    assert.deepEqual(await searchThreadReferences({ id: owner, [tokenWorkspace]: workspace }, workspace, 'checkout'), items)
    await assert.rejects(searchThreadReferences({ id: owner, [tokenWorkspace]: foreign }, workspace, 'checkout'), { code: 'workspaceAccessDenied' })
    assert.deepEqual(await searchThreadReferences(other, foreign, 'checkout'), [])
    await assert.rejects(searchThreadReferences(other, workspace, 'checkout'))
    await pool.query(`UPDATE issues SET content=jsonb_set(content,'{attrs,mikka,deletedAt}',to_jsonb(now())) WHERE id=$1`, [issue])
    assert.deepEqual(await searchThreadReferences(owner, workspace, 'checkout'), [])

    // A newer bot still matches behind hundreds of older ones: the cap never applies before the name filter.
    const special = randomUUID()
    await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name,"createdAt") SELECT gen_random_uuid(),$1,$2,'Filler '||n, now() - (n||' seconds')::interval FROM generate_series(1,600) n`, [workspace, owner])
    await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Special helper\')', [special, workspace, owner])
    assert.deepEqual(await searchThreadReferences(owner, workspace, 'special', 'bot'), [{ kind: 'bot', id: special, title: 'Special helper' }])
    const greek = randomUUID()
    await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'ΟΣ\')', [greek, workspace, owner])
    assert.deepEqual(await searchThreadReferences(owner, workspace, 'ος', 'bot'), [{ kind: 'bot', id: greek, title: 'ΟΣ' }])
  } finally {
    await pool.query('DELETE FROM bots WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM conversations WHERE id=$1', [chat])
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [run])
    await pool.query('DELETE FROM issues WHERE id=$1', [issue])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=ANY($1)', [[owner, other]])
    await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=ANY($1)', [[owner, other]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, other]])
  }
})

test('a task is found by its code as typed: the whole identifier or its start, any case', { skip: !disposableDatabase(), timeout: 120_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { searchThreadReferences } = await import('../lib/thread-reference-search')
  const owner = 'mention-' + randomUUID(), other = 'mention-' + randomUUID()
  const task = randomUUID(), gone = randomUUID(), foreignTask = randomUUID()
  try {
    for (const user of [owner, other]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    const workspace = await seedFixtureWorkspace(pool, owner)
    const foreign = await seedFixtureWorkspace(pool, other)
    const insert = (id: string, user: string, w: string, code: string, title: string, deleted = false) => pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState","issuedIdentifier")
      VALUES ($1,$2,$3,$4,'todo','normal',$5,'bound',$6)`, [id, user, title, JSON.stringify({ type: 'doc', attrs: { mikka: deleted ? { deletedAt: new Date().toISOString() } : {} } }), w, code])
    await insert(task, owner, workspace, 'CHAT-1', '校验聊天结构')
    await insert(gone, owner, workspace, 'CHAT-2', '已删除', true)
    await insert(foreignTask, other, foreign, 'CHAT-3', '别处的任务')
    for (const query of ['CHAT', 'chat', 'CHAT-1', 'chat-1', 'CHAT-']) {
      assert.deepEqual((await searchThreadReferences(owner, workspace, query)).filter(item => item.kind === 'task').map(item => [item.id, item.title]),
        [[task, 'CHAT-1 校验聊天结构']], query)
    }
    assert.deepEqual(await searchThreadReferences(owner, workspace, 'CHAT_', 'task'), [], 'an underscore is a letter, not a wildcard')
    assert.deepEqual((await searchThreadReferences(owner, workspace, '校验', 'task')).map(item => item.id), [task], 'a title still finds it')
  } finally {
    await pool.query('DELETE FROM issues WHERE id=ANY($1)', [[task, gone, foreignTask]])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=ANY($1)', [[owner, other]])
    await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=ANY($1)', [[owner, other]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, other]])
  }
})
