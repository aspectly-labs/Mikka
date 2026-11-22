// Real isolated PostgreSQL: Edit and Regenerate in a Bot chat (decision 2026-11-22-1700). The latest turn leaves the
// chat and the Bot's history and is kept as a version; only the chat's owner, only a turn of words alone.
import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'

const enabled = disposableDatabase()

test('bot chat revisions', { skip: !enabled }, async t => {
  const { db, pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { beginRevision, abandonRevision, revisionCleared, claimRevisionImport, readTurnVersions, revisionSubmissionId } = await import('../lib/coordinator/turn-revisions')
  const { priorHistory } = await import('../lib/eve/history')
  const { chatView } = await import('../lib/coordinator/store')
  const { reviseCoordinatorTurn, coordinatorTurnVersions } = await import('../app/actions/coordinator')
  const owner = `revise-owner-${randomUUID()}`, member = `revise-member-${randomUUID()}`, stranger = `revise-stranger-${randomUUID()}`
  const team = randomUUID(), home = randomUUID(), strangerHome = randomUUID()
  const bot = randomUUID(), homeBot = randomUUID(), memberBot = randomUUID()
  for (const id of [owner, member, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
  await seedFixtureWorkspace(workspacePool, owner, 'team', team)
  await seedFixtureWorkspace(workspacePool, owner, 'personal', home)
  await seedFixtureWorkspace(workspacePool, stranger, 'personal', strangerHome)
  await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$3,'member','active')`, [team, member, `${member}@example.invalid`])
  for (const [id, userId, workspaceId] of [[bot, owner, team], [homeBot, owner, home], [memberBot, member, team]]) await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,\'Revision fixture\')', [id, userId, workspaceId])
  t.after(async () => {
    await pool.query('delete from bots where id = any($1::uuid[])', [[bot, homeBot, memberBot]])
  })

  let position = 0
  const say = async (role: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => {
    position++
    const message: Record<string, unknown> = { role, content, ...extra }
    if (role === 'user') {
      const event = randomUUID(), submissionId = randomUUID()
      await pool.query(`insert into coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt") values($1,$2,$3,'user_message',$4,$5,now())`,
        [event, owner, bot, `revise:${event}`, JSON.stringify({ text: content, source: 'person', submissionId, ...payload })])
      message.mikkaUserEvent = { id: event, submissionId }
    }
    await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,$4,$5)', [randomUUID(), owner, bot, position, JSON.stringify(message)])
    return position
  }
  const scope = { userId: owner, botId: bot, workspaceId: team }
  const changes: string[] = []
  const changed = async () => { changes.push('chat') }
  const texts = async () => (await chatView(owner, 50, bot)).items.map(item => `${item.from}:${item.text}`)

  await say('user', 'What is a monad?')
  await say('assistant', [{ type: 'text', text: 'A monoid in the category of endofunctors.' }])
  const asked = await say('user', 'Say it simply')
  const replied = await say('assistant', [{ type: 'reasoning', text: 'keep it short' }, { type: 'text', text: 'A box with a rule for chaining.' }])

  await t.test('only the latest turn, and only its own positions', async () => {
    await assert.rejects(beginRevision(db as never, scope, { operation: 'edit', position: 1, requestId: randomUUID(), text: 'x' }, changed), /chatRevisionUnavailable/)
    await assert.rejects(beginRevision(db as never, scope, { operation: 'regenerate', position: asked, requestId: randomUUID() }, changed), /chatRevisionUnavailable/)
    await assert.rejects(beginRevision(db as never, scope, { operation: 'regenerate', position: 2, requestId: randomUUID() }, changed), /chatRevisionUnavailable/)
    assert.equal(changes.length, 0)
  })

  await t.test('regenerate takes the turn out of the chat and the history, keeps it as a version, and is idempotent', async () => {
    const requestId = randomUUID()
    const sent = await beginRevision(db as never, scope, { operation: 'regenerate', position: replied, requestId }, changed)
    assert.equal(sent.text, 'Say it simply')
    assert.equal(sent.cleared, false)
    assert.equal(sent.submissionId, revisionSubmissionId(sent.id))
    assert.deepEqual(await texts(), ['person:What is a monad?', 'coordinator:A monoid in the category of endofunctors.'])
    assert.deepEqual((await priorHistory({ ownerId: owner, botId: bot, workspaceId: team, surface: 'web' })).map(row => row.text), ['What is a monad?', 'A monoid in the category of endofunctors.'])
    assert.deepEqual(await beginRevision(db as never, scope, { operation: 'regenerate', position: replied, requestId }, changed), sent, 'the same request returns the same revision')
    await assert.rejects(beginRevision(db as never, scope, { operation: 'edit', position: asked, requestId, text: 'other' }, changed), /submissionConflict/)
    // Nothing waits to import until eve has cleared the Bot's history.
    assert.equal(await claimRevisionImport(pool, scope), false)
    await revisionCleared(db as never, scope, sent.id)
    assert.equal(await claimRevisionImport(pool, scope), true)
    assert.equal(await claimRevisionImport(pool, scope), false, 'the history goes back once')
    // The new message eve accepted, and its reply, stand for the turn now.
    position++
    const event = randomUUID()
    await pool.query(`insert into coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt") values($1,$2,$3,'user_message',$4,$5,now())`,
      [event, owner, bot, `revise:${event}`, JSON.stringify({ text: 'Say it simply', source: 'person', submissionId: sent.submissionId })])
    await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,$4,$5)', [randomUUID(), owner, bot, position, JSON.stringify({ role: 'user', content: 'Say it simply', mikkaUserEvent: { id: event, submissionId: sent.submissionId } })])
    await say('assistant', 'Something you can chain.')
    assert.deepEqual(await readTurnVersions(db as never, owner, bot), { [sent.submissionId]: [{ person: 'Say it simply', reply: 'A box with a rule for chaining.', at: (await readTurnVersions(db as never, owner, bot))[sent.submissionId]![0]!.at }] })
  })

  await t.test('an edit of the new message joins the same turn’s versions', async () => {
    const versions = await readTurnVersions(db as never, owner, bot)
    const [current] = Object.keys(versions)
    const sent = await beginRevision(db as never, scope, { operation: 'edit', position: position - 1, requestId: randomUUID(), text: 'Explain it to a child' }, changed)
    assert.equal(sent.text, 'Explain it to a child')
    const after = await readTurnVersions(db as never, owner, bot)
    assert.deepEqual(Object.keys(after), [sent.submissionId], 'the turn is now found by the edited message')
    assert.deepEqual(after[sent.submissionId]!.map(version => [version.person, version.reply]), [['Say it simply', 'A box with a rule for chaining.'], ['Say it simply', 'Something you can chain.']])
    assert.ok(current)
    await abandonRevision(db as never, scope, sent.id, changed)
    assert.deepEqual(Object.keys(await readTurnVersions(db as never, owner, bot)), [current], 'a refused clear puts the turn back')
    assert.deepEqual((await texts()).slice(-2), ['person:Say it simply', 'coordinator:Something you can chain.'])
  })

  await t.test('a turn that ran a tool, a task request, or a message still waiting cannot be revised', async () => {
    await say('user', 'Make a task for the release')
    const toolReply = await say('assistant', [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'create_task', input: {} }])
    await assert.rejects(beginRevision(db as never, scope, { operation: 'regenerate', position: toolReply, requestId: randomUUID() }, changed), /chatRevisionUnavailable/)
    const task = await say('user', 'Ship it', {}, { taskCommand: { description: 'Ship it' } })
    await assert.rejects(beginRevision(db as never, scope, { operation: 'edit', position: task, requestId: randomUUID(), text: 'Ship it now' }, changed), /chatRevisionUnavailable/)
    const plain = await say('user', 'Thanks')
    await pool.query(`insert into coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) values($1,$2,$3,'user_message',$4,'{"text":"queued","source":"person"}')`, [randomUUID(), owner, bot, `revise:${randomUUID()}`])
    await assert.rejects(beginRevision(db as never, scope, { operation: 'edit', position: plain, requestId: randomUUID(), text: 'Thank you' }, changed), /chatRevisionBusy/)
    await pool.query('delete from coordinator_events where "botId"=$1 and "deliveredAt" is null', [bot])
  })

  await t.test('another person, another member, another workspace and a foreign bot are refused before anything changes', async () => {
    const before = await texts()
    const input = { operation: 'edit' as const, position, requestId: randomUUID(), text: 'Taken over' }
    assert.deepEqual(await withActivitySession(stranger, () => reviseCoordinatorTurn(bot, input), strangerHome), { error: 'botNotFound', params: undefined })
    assert.deepEqual(await withActivitySession(member, () => reviseCoordinatorTurn(bot, input), team), { error: 'botNotFound', params: undefined })
    assert.deepEqual(await withActivitySession(owner, () => reviseCoordinatorTurn(bot, input), home), { error: 'botNotFound', params: undefined }, 'the bot belongs to another workspace than the one open')
    assert.deepEqual(await withActivitySession(owner, () => reviseCoordinatorTurn(memberBot, input), team), { error: 'botNotFound', params: undefined })
    await assert.rejects(withActivitySession(member, () => coordinatorTurnVersions(bot), team), /botNotFound/)
    await assert.rejects(withActivitySession(stranger, () => coordinatorTurnVersions(bot), strangerHome), /botNotFound/)
    assert.deepEqual(await withActivitySession(owner, () => coordinatorTurnVersions(homeBot), home), {})
    assert.deepEqual(await texts(), before)
    assert.equal((await pool.query('select count(*)::int as n from bot_chat_revisions where "botId"=$1 and "clearedAt" is null', [bot])).rows[0].n, 0)
  })
})
