import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { pool } from '../lib/db.js'
import { connectionModels, setConnectionModels } from '../lib/connection-models.js'
import { seedUser, seedWorkspace } from './support/workspace-admin-db.js'
import { tokenWorkspace } from '../lib/tokens/principal.js'

// #2938: a connection's models list the discovered ids plus 按-id-添加 candidates, each known/enabled.

async function fixture(models = ['gpt-5.2', 'litellm-unknown-1']) {
  const user = { id: await seedUser(pool, 'conn-models'), [tokenWorkspace]: '' }
  const workspace = await seedWorkspace(pool, user.id, [{ userId: user.id, role: 'admin' }])
  user[tokenWorkspace] = workspace.id
  const connectionId = randomUUID()
  await pool.query(
    `INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog","modelSettings",quota)
     VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'fixture-subject',$6::jsonb,$7::jsonb,NULL)`,
    [connectionId, user.id, workspace.id, `fixture-${connectionId}`, 'a'.repeat(64),
     JSON.stringify({ revision: '1', models }),
     JSON.stringify({ models: { 'gpt-5.2': { enabled: false } } })])
  return { user, workspace, connectionId }
}

test('connectionModels reports known + enabled per model, kept ids included', async () => {
  const { user, connectionId } = await fixture()
  const rows = await connectionModels(user as never, connectionId)
  const byId = new Map(rows.map(row => [row.id, row]))
  assert.deepEqual([...byId.keys()].sort(), ['gpt-5.2', 'litellm-unknown-1'])
  assert.equal(byId.get('gpt-5.2')!.enabled, false)
  assert.equal(byId.get('litellm-unknown-1')!.enabled, true)
  assert.equal(byId.get('litellm-unknown-1')!.known, false)
})

test('setConnectionModels flips enabled and admits unknown ids as manual candidates', async () => {
  const { user, connectionId } = await fixture()
  const rows = await setConnectionModels(user as never, connectionId, { 'gpt-5.2': true, 'manual-model-9': true })
  const byId = new Map(rows.map(row => [row.id, row]))
  assert.equal(byId.get('gpt-5.2')!.enabled, true)
  assert.equal(byId.get('manual-model-9')!.enabled, true)
  assert.equal(byId.get('manual-model-9')!.known, false)
  const { rows: [saved] } = await pool.query<{ modelSettings: { models: Record<string, { enabled: boolean }> } }>(
    `SELECT "modelSettings" FROM byos_connections WHERE id=$1`, [connectionId])
  assert.equal(saved.modelSettings.models['manual-model-9'].enabled, true)
})

test('another owner cannot read or write the connection\'s models', async () => {
  const { connectionId } = await fixture()
  const outsider = { id: await seedUser(pool, 'conn-models-out'), [tokenWorkspace]: '' }
  await assert.rejects(() => connectionModels(outsider as never, connectionId))
  await assert.rejects(() => setConnectionModels(outsider as never, connectionId, { 'gpt-5.2': true }))
})
