// Real isolated PostgreSQL (Alex, 2026-11-22: open a tool call and see all of it, as Claude, ChatGPT and Cursor do):
// the Bot chat keeps short previews in its reads; opening a row reads that one call's whole input and output, bounded,
// for the chat's owner in the bot's own workspace and for nobody else.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('one stored tool call, whole and owner-only', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readCoordinatorToolCall, TOOL_CALL_CHARS } = await import('../lib/coordinator/tool-call-read')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'toolcall-owner')
  const teammate = await seedUser(pool, 'toolcall-teammate')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const bot = await seedBot(pool, workspace.id, owner)
  const teammateBot = await seedBot(pool, workspace.id, teammate)
  const file = 'export const x = 1\n'.repeat(400)
  const huge = 'y'.repeat(TOOL_CALL_CHARS + 500)
  let position = 0
  const append = async (userId: string, botId: string, message: unknown) => {
    position += 1
    await pool.query('insert into coordinator_messages (id,"userId","botId",position,message) values ($1,$2,$3,$4,$5)', [randomUUID(), userId, botId, position, JSON.stringify(message)])
    return position
  }
  const at = await append(owner, bot, { role: 'assistant', content: [
    { type: 'text', text: '先读文件。' },
    { type: 'tool-call', toolCallId: 'read-1', toolName: 'read_file', input: { path: 'lib/a.ts' } },
    { type: 'tool-call', toolCallId: 'big-1', toolName: 'web_search', input: { query: huge } },
    { type: 'tool-call', toolCallId: 'hidden-1', toolName: 'record_attention', input: { note: 'private' } },
  ] })
  await append(owner, bot, { role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'read-1', toolName: 'read_file', output: { type: 'text', value: file } },
    { type: 'tool-result', toolCallId: 'big-1', toolName: 'web_search', output: { type: 'json', value: { results: [huge] } } },
    { type: 'tool-result', toolCallId: 'hidden-1', toolName: 'record_attention', output: { type: 'text', value: 'private' } },
  ] })
  const teammateAt = await append(teammate, teammateBot, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mate-1', toolName: 'read_file', input: { path: 'secret.ts' } }] })
  await append(teammate, teammateBot, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mate-1', toolName: 'read_file', output: { type: 'text', value: 'teammate only' } }] })

  const read = (input: Partial<Parameters<typeof readCoordinatorToolCall>[1]>) =>
    readCoordinatorToolCall(pool, { ownerId: owner, workspaceId: workspace.id, botId: bot, position: at, toolCallId: 'read-1', ...input })

  await t.test('the owner reads the whole input and output, not the 200-character preview', async () => {
    const call = await read({})
    assert.deepEqual(call, { input: '{"path": "lib/a.ts"}', output: file })
  })

  await t.test('beyond the bound, input and output are cut and say so', async () => {
    const call = await read({ toolCallId: 'big-1' })
    assert.ok(call)
    assert.equal(call.input?.length, TOOL_CALL_CHARS)
    assert.equal(call.output?.length, TOOL_CALL_CHARS)
    assert.equal(call.inputCut, true)
    assert.equal(call.outputCut, true)
  })

  await t.test('a hidden tool is not read', async () => {
    assert.equal(await read({ toolCallId: 'hidden-1' }), null)
  })

  await t.test('another workspace member reading the owner\'s chat is denied', async () => {
    assert.equal(await read({ ownerId: teammate }), null)
  })

  await t.test('a non-owner without any membership is denied', async () => {
    const stranger = await seedUser(pool, 'toolcall-stranger')
    assert.equal(await read({ ownerId: stranger }), null)
  })

  await t.test('the owner\'s bot named under another workspace is denied', async () => {
    assert.equal(await read({ workspaceId: other.id }), null)
  })

  await t.test('a foreign call: another person\'s chat, or a call id from another chat, is denied', async () => {
    assert.equal(await read({ botId: teammateBot, position: teammateAt, toolCallId: 'mate-1' }), null, 'the teammate\'s own bot')
    assert.equal(await read({ toolCallId: 'mate-1' }), null, 'their call id named in the owner\'s chat')
    assert.equal(await read({ position: at + 1 }), null, 'a call before the named reply is not found')
  })
})
