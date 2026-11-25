import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { assignTaskEnvironment } from './helpers/run-project-resources'

// Alex, 2026-11-25: members create personal 「仅我」 environments and share them with the workspace.
test('personal environments: creation, visibility, sharing, management and run admission', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const store = await import('../lib/project-resources/store')
  const { ActionFailureError } = await import('../lib/action-error')
  // The file's last test closes the shared application pools.
  t.after(() => fixture.end())
  const rejects = (work: Promise<unknown>, code: string, message?: string) =>
    assert.rejects(work, (error: unknown) => error instanceof ActionFailureError && error.code === code, message)
  const admin = await seedUser(fixture, 'scope-admin'), member = await seedUser(fixture, 'scope-member'), peer = await seedUser(fixture, 'scope-peer')
  const outsider = await seedUser(fixture, 'scope-outsider')
  const workspace = await seedWorkspace(fixture, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }, { userId: peer, role: 'member' }])
  const listed = async (userId: string) => (await store.listProjectResources(userId, workspace.id)).environments.map(row => row.id)
  const row = async (id: string) => (await fixture.query('SELECT scope,"ownerId",revision FROM workspace_environments WHERE id=$1', [id])).rows[0]
  const events = async (id: string) => (await fixture.query(`SELECT kind,"actorId",detail FROM workspace_resource_events WHERE "resourceId"=$1 AND kind LIKE 'environment.%' ORDER BY "createdAt"`, [id])).rows

  let mine: { id: string; revision: number }
  await t.test('any member creates a personal environment; only administrators create shared ones', async () => {
    await rejects(store.saveEnvironment(member, { workspaceId: workspace.id, name: 'Shared by a member', configuration: {} }), 'workspaceAccessDenied')
    await rejects(store.saveEnvironment(member, { workspaceId: workspace.id, name: 'Explicitly shared', scope: 'workspace', configuration: {} }), 'workspaceAccessDenied')
    await rejects(store.saveEnvironment(outsider, { workspaceId: workspace.id, name: 'Not a member', scope: 'personal', configuration: {} }), 'workspaceAccessDenied')
    mine = await store.saveEnvironment(member, { workspaceId: workspace.id, name: 'Mine', scope: 'personal', configuration: { variables: { MINE: 'yes' } },
      repositories: [{ key: 'v2/github.com/acme/mine', clone: 'start', baseBranch: 'mine', primary: true }] })
    assert.deepEqual(await row(mine.id), { scope: 'personal', ownerId: member, revision: 1 })
    assert.deepEqual((await events(mine.id)).map(event => [event.kind, event.actorId, event.detail.scope]), [['environment.saved', member, 'personal']])
    const shared = await store.saveEnvironment(admin, { workspaceId: workspace.id, name: 'Shared', configuration: {} })
    assert.deepEqual(await row(shared.id), { scope: 'workspace', ownerId: null, revision: 1 })
  })

  await t.test('a personal environment exists only for its owner, administrators included', async () => {
    assert.ok((await listed(member)).includes(mine.id))
    assert.ok(!(await listed(admin)).includes(mine.id))
    assert.ok(!(await listed(peer)).includes(mine.id))
    await rejects(store.saveEnvironment(admin, { workspaceId: workspace.id, id: mine.id, revision: 1, name: 'Taken', configuration: {} }), 'projectResourceConflict')
    await rejects(store.saveEnvironment(admin, { workspaceId: workspace.id, id: mine.id, revision: 1, name: 'Archived by admin', configuration: {}, archived: true }), 'projectResourceConflict')
    await rejects(store.readEnvironmentInstructions(admin, { workspaceId: workspace.id, environmentId: mine.id }), 'projectEnvironmentUnavailable')
    await rejects(store.saveEnvironmentInstructions(admin, { workspaceId: workspace.id, environmentId: mine.id, instructions: 'no' }), 'projectEnvironmentUnavailable')
    assert.equal((await store.readEnvironmentInstructions(member, { workspaceId: workspace.id, environmentId: mine.id })).canEdit, true)
    assert.equal(await store.readableEnvironment(admin, workspace.id, mine.id), false)
    assert.equal(await store.readableEnvironment(member, workspace.id, mine.id), true)
    await rejects(store.saveEnvironment(member, { workspaceId: workspace.id, id: mine.id, revision: 1, name: 'Mine', scope: 'workspace', configuration: {} }), 'validationGeneric',
      'scope changes only through share and unshare')
    mine = await store.saveEnvironment(member, { workspaceId: workspace.id, id: mine.id, revision: 1, name: 'Mine', configuration: { variables: { MINE: 'edited' } },
      repositories: [{ key: 'v2/github.com/acme/mine', clone: 'start', baseBranch: 'mine', primary: true }] })
    assert.deepEqual(await row(mine.id), { scope: 'personal', ownerId: member, revision: 2 }, 'saving keeps scope and owner')
  })

  await t.test('runs may use a personal environment only for its owner', async () => {
    const memberTask = await seedIssue(fixture, member, workspace.id)
    await assignTaskEnvironment(fixture, member, workspace.id, [memberTask], mine.id)
    const admit = (userId: string) => store.withProjectExecution({ userId, workspaceId: workspace.id, issueId: memberTask,
      repositoryKey: 'v2/github.com/acme/mine', baseBranch: 'main', runtime: 'local', harness: 'codex' }, async snapshot => snapshot)
    const own = await admit(member)
    assert.deepEqual([own.environment?.id, own.environment?.scope, own.environment?.variables.MINE, own.baseBranch], [mine.id, 'personal', 'edited', 'mine'])
    await rejects(admit(peer), 'projectEnvironmentUnavailable')
    await rejects(admit(admin), 'projectEnvironmentUnavailable', 'administrators cannot run in someone else\'s personal environment')
    await rejects(store.withProjectExecution({ userId: admin, workspaceId: workspace.id, issueId: memberTask, repositoryKey: null, baseBranch: null,
      runtime: 'local', harness: 'codex', environmentId: mine.id }, async snapshot => snapshot), 'projectEnvironmentUnavailable', 'nor choose it for a run')
    await assert.rejects(assignTaskEnvironment(fixture, peer, workspace.id, [memberTask], mine.id), { code: 'projectEnvironmentUnavailable' })
  })

  await t.test('only the owner shares; the owner or an administrator takes it back; both are idempotent and audited', async () => {
    const scope = { workspaceId: workspace.id, environmentId: mine.id }
    await rejects(store.setEnvironmentScope(admin, scope, 'workspace'), 'projectEnvironmentUnavailable', 'an administrator cannot see it to share it')
    await rejects(store.setEnvironmentScope(peer, scope, 'workspace'), 'projectEnvironmentUnavailable')
    await rejects(store.setEnvironmentScope(outsider, scope, 'workspace'), 'workspaceAccessDenied')
    assert.deepEqual(await store.setEnvironmentScope(member, scope, 'workspace'), { id: mine.id, scope: 'workspace', ownerId: member })
    assert.deepEqual(await store.setEnvironmentScope(member, scope, 'workspace'), { id: mine.id, scope: 'workspace', ownerId: member })
    assert.deepEqual(await row(mine.id), { scope: 'workspace', ownerId: member, revision: 2 }, 'sharing keeps the owner and changes no run setting')
    assert.ok((await listed(admin)).includes(mine.id) && (await listed(peer)).includes(mine.id))
    assert.equal(await store.readableEnvironment(peer, workspace.id, mine.id, { shared: true }), true)
    // Shared: the owner still edits it, administrators may, other members may not.
    await rejects(store.saveEnvironment(peer, { workspaceId: workspace.id, id: mine.id, revision: 2, name: 'Peer edit', configuration: {} }), 'workspaceAccessDenied')
    mine = await store.saveEnvironment(admin, { workspaceId: workspace.id, id: mine.id, revision: 2, name: 'Mine (shared)', configuration: { variables: { MINE: 'edited' } } })
    mine = await store.saveEnvironment(member, { workspaceId: workspace.id, id: mine.id, revision: mine.revision, name: 'Mine (shared)', configuration: { variables: { MINE: 'edited' } } })
    const peerTask = await seedIssue(fixture, peer, workspace.id)
    await assignTaskEnvironment(fixture, peer, workspace.id, [peerTask], mine.id)
    const peerRun = await store.withProjectExecution({ userId: peer, workspaceId: workspace.id, issueId: peerTask, repositoryKey: null, baseBranch: null,
      runtime: 'local', harness: 'codex' }, async snapshot => snapshot)
    assert.equal(peerRun.environment?.id, mine.id, 'a shared environment admits every member\'s runs')
    await rejects(store.setEnvironmentScope(peer, scope, 'personal'), 'workspaceAccessDenied', 'another member cannot take it back')
    assert.deepEqual(await store.setEnvironmentScope(admin, scope, 'personal'), { id: mine.id, scope: 'personal', ownerId: member }, 'an administrator returns it to its owner')
    await rejects(store.withProjectExecution({ userId: peer, workspaceId: workspace.id, issueId: peerTask, repositoryKey: null, baseBranch: null,
      runtime: 'local', harness: 'codex' }, async snapshot => snapshot), 'projectEnvironmentUnavailable', 'the next admission of another member\'s run is refused')
    assert.deepEqual((await events(mine.id)).filter(event => event.kind !== 'environment.saved').map(event => [event.kind, event.actorId, event.detail.ownerId]),
      [['environment.shared', member, member], ['environment.unshared', admin, member]])
  })

  await t.test('workspace setup approval belongs to an administrator', async () => {
    const setup = { command: 'node --version', approved: true, copyFiles: [] }
    const personal = await store.saveEnvironment(member, { workspaceId: workspace.id, scope: 'personal', name: 'Setup approval', configuration: { setup } })
    const ref = { workspaceId: workspace.id, environmentId: personal.id }
    const approval = async () => (await store.listProjectResources(member, workspace.id)).environments.find(env => env.id === personal.id)!.configuration.setup!.approved
    assert.equal(await approval(), true)
    await store.setEnvironmentScope(member, ref, 'workspace')
    assert.equal(await approval(), false)
    const edit = { workspaceId: workspace.id, id: personal.id, name: 'Shared setup', configuration: { setup } }
    const memberWrite = await store.saveEnvironment(member, { ...edit, revision: personal.revision + 1 })
    assert.equal(await approval(), false)
    await store.saveEnvironment(admin, { ...edit, revision: memberWrite.revision })
    assert.equal(await approval(), true)
  })

  await t.test('an administrator taking back an ownerless shared environment becomes its owner', async () => {
    const legacy = await store.saveEnvironment(admin, { workspaceId: workspace.id, name: 'Legacy shared', configuration: {} })
    await rejects(store.setEnvironmentScope(member, { workspaceId: workspace.id, environmentId: legacy.id }, 'personal'), 'workspaceAccessDenied')
    assert.deepEqual(await store.setEnvironmentScope(admin, { workspaceId: workspace.id, environmentId: legacy.id }, 'personal'), { id: legacy.id, scope: 'personal', ownerId: admin })
    assert.ok(!(await listed(member)).includes(legacy.id))
    await store.saveEnvironment(admin, { workspaceId: workspace.id, id: legacy.id, revision: 1, name: 'Legacy shared', configuration: {}, archived: true })
    await rejects(store.setEnvironmentScope(admin, { workspaceId: workspace.id, environmentId: legacy.id }, 'workspace'), 'projectArchived')
  })

  await t.test('a Bot binds and defaults to shared environments only', async () => {
    const { assertBotEnvironment, botEnvironmentOptions } = await import('../lib/bot-environment')
    const personal = await store.saveEnvironment(admin, { workspaceId: workspace.id, name: 'Admin only', scope: 'personal', configuration: {} })
    await assert.rejects(assertBotEnvironment(admin, workspace.id, personal.id), { code: 'botEnvironmentUnavailable' })
    assert.ok(!(await botEnvironmentOptions(workspace.id)).some(option => option.id === personal.id))
    const lonely = await seedWorkspace(fixture, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const solo = await store.saveEnvironment(member, { workspaceId: lonely.id, name: 'Only personal', scope: 'personal', configuration: {} })
    const made = await store.ensureBotEnvironment(member, lonely.id, 'Default', [])
    assert.notEqual(made, solo.id, 'a new Bot never lands in a member\'s personal environment')
    assert.deepEqual(await row(made), { scope: 'workspace', ownerId: null, revision: 1 })
    const botId = randomUUID(), issueId = await seedIssue(fixture, member, lonely.id)
    await fixture.query('insert into bots (id,"workspaceId","ownerId",name,"environmentId") values($1,$2,$3,$4,$5)', [botId, lonely.id, member, 'Fixture Bot', made])
    const run = () => store.withProjectExecution({ userId: member, botId, workspaceId: lonely.id, issueId,
      repositoryKey: null, baseBranch: null, runtime: 'local', harness: 'codex' }, async snapshot => snapshot)
    assert.equal((await run()).environment?.id, made)
    await assignTaskEnvironment(fixture, member, lonely.id, [issueId], solo.id)
    assert.equal((await run()).environment?.id, solo.id, 'an explicit personal selection takes precedence for its owner')
  })
})

test('repository rows: on-demand clone under the workspace repository policy', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const store = await import('../lib/project-resources/store')
  t.after(async () => { await Promise.all([fixture.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(fixture, 'on-demand-owner')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
  const issueId = await seedIssue(fixture, owner, workspace.id)
  const start = 'v2/github.com/acme/start', demand = 'v2/github.com/acme/demand', elsewhere = 'v2/github.com/acme/elsewhere'
  const environment = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Two kinds', configuration: {},
    repositories: [{ key: start, clone: 'start', baseBranch: 'main', primary: true }, { key: demand, clone: 'demand', baseBranch: 'next' }] })
  await assignTaskEnvironment(fixture, owner, workspace.id, [issueId], environment.id)
  const admit = (repositoryKey: string | null) => store.withProjectExecution({ userId: owner, workspaceId: workspace.id, issueId, repositoryKey,
    baseBranch: 'device-default', runtime: 'cloud', harness: 'codex' }, async snapshot => snapshot)
  const shape = (snapshot: Awaited<ReturnType<typeof admit>>) => [snapshot.repositoryKey, snapshot.repositoryClone ?? null, snapshot.baseBranch]
  assert.deepEqual(shape(await admit(start)), [start, 'start', 'main'])
  assert.deepEqual(shape(await admit(demand)), [demand, 'demand', 'next'])
  assert.deepEqual(shape(await admit(elsewhere)), [elsewhere, 'demand', 'device-default'], 'outside the environment: cloned on demand, recorded on the run')
  assert.deepEqual(shape(await admit(null)), [null, null, 'device-default'])
  const snapshot = await admit(elsewhere)
  assert.deepEqual(snapshot.environment?.repositories?.map(row => [row.key, row.clone]), [[start, 'start'], [demand, 'demand']], 'the run records the environment\'s rows')
  assert.deepEqual(snapshot.environment?.repositoryKeys, [start])
  await store.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 0, mode: 'restricted', repositoryKeys: [start, demand] })
  await assert.rejects(admit(elsewhere), { code: 'projectRepositoryDenied' }, 'the workspace repository policy still refuses repositories it does not admit')
  assert.deepEqual(shape(await admit(demand)), [demand, 'demand', 'next'])
  await store.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 1, mode: 'restricted', repositoryKeys: [demand] })
  await assert.rejects(admit(demand), { code: 'projectRepositoryDenied' }, 'extra startup repositories also require current workspace permission')
  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: environment.id, name: 'Repository default', revision: 1,
    configuration: {}, repositories: [{ key: demand, clone: 'demand', baseBranch: null }] })
  assert.equal((await admit(demand)).baseBranch, null, 'the repository default takes precedence over a configured device branch')
  await store.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 2, mode: 'restricted', repositoryKeys: [] })
  await assert.rejects(admit(start), { code: 'projectRepositoryDenied' }, 'an environment row grants nothing the policy refuses')
  assert.equal((await admit(null)).environment?.id, environment.id, 'a default environment needs no repository')

})
