// Bot 改名与换形象（右栏）against a real PostgreSQL: validation, duplicates and owner/workspace scoping.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as lists from '../lib/live/lists'
import * as groups from '../lib/live/groups'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

// The live writers this test watches: a Bot's look also stands in its groups' avatars and member lists.
const pushed: string[] = []
mock.module(new URL('../lib/live/lists.ts', import.meta.url).href, { namedExports: { ...lists, botGroupsChanged: async (_executor: object, botId: string) => { pushed.push(`group_list:${botId}`) } } })
mock.module(new URL('../lib/live/groups.ts', import.meta.url).href, { namedExports: { ...groups, botGroupChatsChanged: async (_executor: object, botId: string) => { pushed.push(`group_chat:${botId}`) } } })

test('update a bot', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { ActionFailureError } = await import('../lib/action-error')
  const { updateOwnedBot } = await import('../lib/bot-update')
  const { pool: appPool } = await import('../lib/db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof ActionFailureError && error.code === code)
  const nameOf = async (id: string) => (await pool.query<{ name: string; color: string; shape: string }>('select name, color, shape from bots where id=$1', [id])).rows[0]

  const owner = await seedUser(pool, 'owner'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }, { userId: owner, role: 'member' }])
  const bot = await seedBot(pool, ws.id, owner, 'Reviewer')
  await seedBot(pool, ws.id, owner, 'Writer')
  const me = { ownerId: owner, workspaceId: ws.id }

  await t.test('renames, trims, and changes shape and colour', async () => {
    assert.deepEqual(await updateOwnedBot(me, { botId: bot, name: '  Release notes  ' }), { id: bot, name: 'Release notes', color: 'encre', shape: 'cercle',publicRole:'' })
    assert.deepEqual(await updateOwnedBot(me, { botId: bot, color: 'vert', shape: 'hexagone' }), { id: bot, name: 'Release notes', color: 'vert', shape: 'hexagone',publicRole:'' })
    assert.deepEqual(await nameOf(bot), { name: 'Release notes', color: 'vert', shape: 'hexagone' })
    // Its own name in another case is not a clash with itself.
    assert.equal((await updateOwnedBot(me, { botId: bot, name: 'RELEASE NOTES' })).name, 'RELEASE NOTES')
  })

  await t.test('a new name or look pushes the groups the Bot is in; a duty change does not', async () => {
    pushed.length = 0
    await updateOwnedBot(me, { botId: bot, color: 'rouge' })
    assert.deepEqual(pushed, [`group_list:${bot}`, `group_chat:${bot}`])
    pushed.length = 0
    await updateOwnedBot(me, { botId: bot, publicRole: 'Reviews' })
    assert.deepEqual(pushed, [])
    await rejects(updateOwnedBot({ ownerId: member, workspaceId: ws.id }, { botId: bot, shape: 'hexagone' }), 'botNotFound')
    assert.deepEqual(pushed, [], 'a refused change pushes nothing')
    await updateOwnedBot(me, { botId: bot, color: 'vert', publicRole: '' })
  })

  await t.test('rejects an empty, too long or duplicate name and leaves the bot alone', async () => {
    const before = await nameOf(bot)
    await rejects(updateOwnedBot(me, { botId: bot, name: '   ' }), 'validationNameRequired')
    await rejects(updateOwnedBot(me, { botId: bot, name: 'x'.repeat(61) }), 'botNameTooLong')
    assert.equal((await updateOwnedBot(me, { botId: bot, name: 'x'.repeat(60) })).name, 'x'.repeat(60))
    await updateOwnedBot(me, { botId: bot, name: before.name })
    await rejects(updateOwnedBot(me, { botId: bot, name: 'writer' }), 'botDuplicateName')
    await rejects(updateOwnedBot(me, { botId: bot, shape: 'carre' }), 'validationGeneric')
    await rejects(updateOwnedBot(me, { botId: bot }), 'validationGeneric')
    assert.deepEqual(await nameOf(bot), before)
  })

  await t.test('another workspace, another member or a bad id reads as not found', async () => {
    const before = await nameOf(bot)
    await rejects(updateOwnedBot({ ownerId: owner, workspaceId: other.id }, { botId: bot, name: 'Moved' }), 'botNotFound')
    await rejects(updateOwnedBot({ ownerId: member, workspaceId: ws.id }, { botId: bot, name: 'Taken' }), 'botNotFound')
    await rejects(updateOwnedBot({ ownerId: outsider, workspaceId: other.id }, { botId: bot, name: 'Taken' }), 'botNotFound')
    await rejects(updateOwnedBot(me, { botId: 'not-a-uuid', name: 'Taken' }), 'botNotFound')
    assert.deepEqual(await nameOf(bot), before)
  })
  await t.test('public duties are explicit, editable, clearable and owner scoped',async()=>{
    assert.equal((await updateOwnedBot(me,{botId:bot,publicRole:'  UI and interaction design  '})).publicRole,'UI and interaction design')
    assert.equal((await pool.query('SELECT "publicRole" FROM bots WHERE id=$1',[bot])).rows[0].publicRole,'UI and interaction design')
    await rejects(updateOwnedBot({ownerId:member,workspaceId:ws.id},{botId:bot,publicRole:'Take over duties'}),'botNotFound')
    await rejects(updateOwnedBot({ownerId:owner,workspaceId:other.id},{botId:bot,publicRole:'Other workspace'}),'botNotFound')
    await rejects(updateOwnedBot(me,{botId:bot,publicRole:'x'.repeat(2001)}),'validationGeneric')
    assert.equal((await updateOwnedBot(me,{botId:bot,publicRole:''})).publicRole,'')
  })
})
