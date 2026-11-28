// Real isolated PostgreSQL (#2927): `environments.listEnvironments` is on the frontend allowlist so a Bot's chat can
// show its Environment in the right column's Setup tab. The workspace's members read its Environments; anyone else is
// refused by the store's own membership check, even with a stale workspace context.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { ActionFailureError } from '../lib/action-error'
import { WorkspaceError } from '../lib/workspace-error'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('listEnvironments reads only the reader\'s own workspace, for its members', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([fixture.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(fixture, 'env-list-owner'), member = await seedUser(fixture, 'env-list-member')
  const outsider = await seedUser(fixture, 'env-list-outsider'), peer = await seedUser(fixture, 'env-list-peer')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const foreign = await seedWorkspace(fixture, peer, [{ userId: peer, role: 'admin' }])
  let current: { id: string; name: string; email: string } | null = null
  const mocks = [
    mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => { if (!current) throw new ActionFailureError('authRequired'); return current } } }),
    // A stale context that names whatever workspace was asked for: the store must recheck membership itself.
    mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError,
      loadWorkspaceContext: async (requested?: string) => ({ workspace: { id: requested ?? workspace.id }, role: 'member' }) } }),
  ]
  t.after(() => { for (const replacement of mocks.reverse()) replacement.restore() })
  const store = await import('../lib/project-resources/store')
  const mine = await store.saveEnvironment(owner, {
    workspaceId: workspace.id,
    name: 'mikka-dev',
    configuration: {
      runtime: 'cloud',
      repositoryKeys: ['v2/github.com/acme/mikka'],
      startScript: 'pnpm dev',
      networkAccess: 'restricted',
      setup: { copyFiles: [], command: 'pnpm install', approved: true },
    },
  })
  // Older editor round-trip: omitting startScript & networkAccess preserves saved values.
  await store.saveEnvironment(owner, {
    workspaceId: workspace.id,
    id: mine.id,
    revision: mine.revision,
    name: 'mikka-dev',
    configuration: {
      runtime: 'cloud',
      repositoryKeys: ['v2/github.com/acme/mikka'],
      setup: { copyFiles: [], command: 'pnpm install', approved: true },
    },
  })
  // Legacy checkout-path device_repos row for the reader should still surface via remoteUrl normalization.
  const deviceId = randomUUID()
  const repoId = randomUUID()
  await fixture.query(
    `INSERT INTO devices (id, "ownerId", name) VALUES ($1, $2, 'legacy-laptop')`,
    [deviceId, member],
  )
  await fixture.query(
    `INSERT INTO device_repos (id, "deviceId", "userId", "repoPath", "remoteUrl") VALUES ($1, $2, $3, '/Users/dev/acme-legacy', 'https://github.com/acme/legacy.git')`,
    [repoId, deviceId, member],
  )
  const theirs = await store.saveEnvironment(peer, { workspaceId: foreign.id, name: 'other-team', configuration: {} })
  const { listEnvironments } = await import('../app/actions/environments')
  const as = (id: string) => { current = { id, name: id, email: `${id}@example.invalid` } }

  as(member)
  const read = await listEnvironments(workspace.id)
  assert.deepEqual(read.environments.map(environment => environment.id), [mine.id], 'a member reads the workspace\'s Environments')
  assert.equal(read.environments[0]?.configuration.setup?.command, 'pnpm install')
  assert.equal(read.environments[0]?.configuration.startScript, 'pnpm dev')
  assert.equal(read.environments[0]?.configuration.networkAccess, 'restricted')
  assert.deepEqual(read.availableRepositories, [
    { key: 'v2/github.com/acme/legacy', label: 'acme/legacy' },
    { key: 'v2/github.com/acme/mikka', label: 'acme/mikka' },
  ])
  assert.deepEqual(read.availableSecrets, [])
  assert.equal(read.canManage, false)
  assert.ok(!JSON.stringify(read).includes(theirs.id), 'never another workspace\'s Environment')

  for (const [who, label] of [[outsider, 'not a member'], [peer, 'a member of another workspace']] as const) {
    as(who)
    await assert.rejects(listEnvironments(workspace.id), label)
  }
  as(member)
  await assert.rejects(listEnvironments(foreign.id), 'a member asking for a workspace they are not in')
  current = null
  await assert.rejects(listEnvironments(workspace.id), /authRequired/, 'signed out')
})
