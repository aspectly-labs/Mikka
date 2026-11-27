import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { WorkspaceError } from '../lib/workspace-error'

// 设置 › 模型 actions (decision 2026-11-27-1740): a person's key is never shared into a
// workspace. The hosted page's one-release `share: true` adds a key the workspace owns,
// and only a team workspace's admin may do it or manage that key; the retired move
// answers apiKeySharingRetired and changes nothing. The store is real elsewhere
// (tests/model-api-keys.db.test.ts); this suite pins who the actions hand it.
const team = { id: '10000000-0000-4000-8000-000000000001', name: 'Fixture team', kind: 'team' as const }
const personal = { id: '10000000-0000-4000-8000-000000000002', name: 'Mine', kind: 'personal' as const }
const workspaceKeyId = '10000000-0000-4000-8000-000000000003', ownKeyId = '10000000-0000-4000-8000-000000000004'
let context = { workspace: team as { id: string; name: string; kind: 'team' | 'personal' }, role: 'admin' }
const calls: { name: string; owner: unknown; options?: unknown }[] = []

mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => ({ id: 'alice' }) } })
mock.module('@/lib/workspace-access', { namedExports: { loadWorkspaceContext: async () => context, WorkspaceError } })
mock.module('@/lib/fresh-session', { namedExports: { withFreshSession: (fn: () => unknown) => fn() } })
mock.module('@/lib/db', { namedExports: { pool: {} } })
mock.module('@/lib/model-api-keys', { namedExports: {
  addApiKey: async (_pool: unknown, owner: unknown, _input: unknown, options?: unknown) => { calls.push({ name: 'add', owner, options }); return { id: 'new' } },
  updateApiKey: async (_pool: unknown, owner: unknown) => { calls.push({ name: 'update', owner }) },
  removeApiKey: async (_pool: unknown, owner: unknown) => { calls.push({ name: 'remove', owner }); return { removed: true } },
  refreshApiKeyModels: async (_pool: unknown, owner: unknown) => { calls.push({ name: 'refresh', owner }) },
  refreshApiKeyDaybreak: async (_pool: unknown, owner: unknown) => { calls.push({ name: 'daybreak', owner }); return { access: { granted: [] }, key: {} } },
  setApiKeyFeatures: async (_pool: unknown, owner: unknown) => { calls.push({ name: 'features', owner }) },
  setApiKeyAfterQuota: async () => {},
  apiKeyOwnerOf: async (_pool: unknown, id: string) => id === workspaceKeyId ? { ownerId: null, workspaceId: team.id } : id === ownKeyId ? { ownerId: 'alice', workspaceId: null } : null,
  listApiKeys: async (_pool: unknown, _owner: string, workspace: unknown, options: { admin?: boolean }) => { calls.push({ name: 'list', owner: workspace, options }); return { keys: [], canShare: options.admin === true, apiKeyAfterQuota: true } },
  usableApiKeys: async () => [{ id: workspaceKeyId, ownerId: team.id, mine: false, workspace: true }, { id: ownKeyId, ownerId: 'alice', mine: true, workspace: false }],
} })
const actions = await import('../app/actions/model-api-keys')
const as = (workspace: typeof context.workspace, role: string) => { context = { workspace, role }; calls.length = 0 }

test('share:true from an admin adds a key the workspace owns, recording who added it', async () => {
  as(team, 'admin')
  assert.deepEqual(await actions.createApiKey({ provider: 'deepseek', apiKey: 'fixture' }, team.id, { share: true }), { id: 'new' })
  assert.deepEqual(calls, [{ name: 'add', owner: { workspaceId: team.id }, options: { addedBy: 'alice' } }])
})

test('a member who is not an admin cannot add a workspace key; a personal workspace has none', async () => {
  as(team, 'member')
  assert.deepEqual(await actions.createApiKey({ provider: 'deepseek', apiKey: 'fixture' }, team.id, { share: true }), { error: 'workspaceAccessDenied' })
  as(personal, 'admin')
  assert.deepEqual(await actions.createApiKey({ provider: 'deepseek', apiKey: 'fixture' }, personal.id, { share: true }), { error: 'validationGeneric' })
  assert.deepEqual(calls, [])
})

test('without share the key is the person\'s own, whatever their role', async () => {
  as(team, 'member')
  await actions.createApiKey({ provider: 'deepseek', apiKey: 'fixture' }, team.id)
  assert.deepEqual(calls, [{ name: 'add', owner: 'alice', options: undefined }])
})

test('the workspace key is managed by its admins; a member is refused and own keys stay the person\'s', async () => {
  as(team, 'admin')
  await actions.updateApiKey(workspaceKeyId, { name: 'Team' }, team.id)
  await actions.deleteApiKey(workspaceKeyId, team.id)
  await actions.refetchApiKeyModels(workspaceKeyId, team.id)
  await actions.updateApiKeyFeatures(workspaceKeyId, { thinking: false }, team.id)
  assert.deepEqual(calls.filter(call => call.name !== 'list').map(call => [call.name, call.owner]),
    ['update', 'remove', 'refresh', 'features'].map(name => [name, { workspaceId: team.id }]))
  as(team, 'member')
  assert.deepEqual(await actions.deleteApiKey(workspaceKeyId, team.id), { error: 'workspaceAccessDenied' })
  assert.deepEqual(await actions.updateApiKey(workspaceKeyId, { name: 'Mine' }, team.id), { error: 'workspaceAccessDenied' })
  await actions.deleteApiKey(ownKeyId, team.id)
  assert.deepEqual(calls, [{ name: 'remove', owner: { userId: 'alice' } }])
})

test('the page: an admin manages the workspace keys; a member reads them under the workspace name', async () => {
  as(team, 'admin')
  const admin = await actions.getApiKeys(team.id)
  assert.ok(!('error' in admin && admin.error))
  assert.deepEqual([(admin as { canShare: boolean }).canShare, (admin as { sharedKeys: unknown[] }).sharedKeys], [true, []])
  as(team, 'member')
  const member = await actions.getApiKeys(team.id) as { canShare: boolean; sharedKeys: { id: string; ownerName: string }[] }
  assert.equal(member.canShare, false)
  assert.deepEqual(member.sharedKeys.map(key => [key.id, key.ownerName]), [[workspaceKeyId, team.name]], 'only the workspace\'s key, never a teammate\'s')
})

test('moving a key between a person and the workspace is retired', async () => {
  for (const shared of [true, false]) {
    as(team, 'admin')
    assert.deepEqual(await actions.updateApiKeyShare({ id: ownKeyId, shared }, team.id), { error: 'apiKeySharingRetired' })
    assert.deepEqual(calls, [])
  }
})
