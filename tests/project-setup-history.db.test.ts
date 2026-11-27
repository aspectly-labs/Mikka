import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedIssue, seedProject, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { assignTaskEnvironment } from './helpers/run-project-resources'

test('Environment setup history restores only the recipe after fresh scope, reach and authority checks', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl })
  const store = await import('../lib/project-resources/store')
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([database.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(database, 'setup-owner'), member = await seedUser(database, 'setup-member')
  const workspace = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const team = await seedTeam(database, workspace.id, owner)
  const projectId = await seedProject(database, owner, [{ teamId: team.id, workspaceId: workspace.id }])
  const env = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Setup history', configuration: {
    variables: { CURRENT_VALUE: 'old' }, setup: { copyFiles: ['fixture.txt'], command: 'node --version', approved: true },
  } })

  await t.test('the retired Project setup view stays readable and no longer selects a Run environment', async () => {
    const projectId = await seedProject(database, member, [{ teamId: team.id, workspaceId: workspace.id }])
    const read = () => store.readCurrentProjectSetup(member, { workspaceId: workspace.id, projectId })
    assert.deepEqual(await read(), { defaultEnvironmentId: null, repositories: [], environments: [] })
    // A binding written before the retirement is still shown, read-only.
    await database.query('INSERT INTO workspace_project_environments("projectId","workspaceId","environmentId","isDefault") VALUES($1,$2,$3,true)', [projectId, workspace.id, env.id])
    const view = await read()
    assert.equal(view.defaultEnvironmentId, env.id)
    const issueId = await seedIssue(database, member, workspace.id)
    await database.query('INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId") VALUES($1,$2,$3)', [issueId, projectId, workspace.id])
    const snapshot = await store.withProjectExecution({ userId: member, workspaceId: workspace.id, issueId,
      repositoryKey: 'v2/github.com/alpha/api', baseBranch: 'main', runtime: 'local', harness: 'codex' }, async input => input)
    assert.equal(snapshot.projectId, projectId, 'the Project still contains the task')
    assert.equal(snapshot.environment, null, 'the Project default no longer selects the environment')
  })

  // The projectId of an older client is accepted and ignored: history belongs to the environment.
  const scope = { workspaceId: workspace.id, projectId, environmentId: env.id }
  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: env.id, revision: 1, name: 'Current name', configuration: {
    runtime: 'local', variables: { CURRENT_VALUE: 'now' }, setup: { copyFiles: [], command: 'node --help', approved: true },
  } })
  const history = await store.listProjectSetupVersions(member, { workspaceId: workspace.id, environmentId: env.id })
  assert.equal(history.totalTasks, 0)
  assert.deepEqual(history.versions.map(v => [v.revision, v.recipe]), [[2, { command: 'node --help', copyFiles: [] }],
    [1, { command: 'node --version', copyFiles: ['fixture.txt'] }]])
  assert.equal(history.before, null)
  assert.ok(!JSON.stringify(history).includes('approved'))
  assert.ok(!JSON.stringify(history).includes('CURRENT_VALUE'))
  assert.deepEqual(await store.listProjectSetupVersions(owner, scope), history, 'an older client\'s Project scope reads the same history')
  const request = { ...scope, revision: 2, version: 1, bindingSnapshot: history.bindingSnapshot }
  await assert.rejects(store.rollbackProjectSetup(member, request), { code: 'workspaceAccessDenied' }, 'a member cannot restore a shared environment')
  await assert.rejects(store.listProjectSetupVersions(owner, { ...scope, environmentId: randomUUID() }), { code: 'projectEnvironmentUnavailable' })
  // A task now uses the environment: the confirmed reach is stale.
  const issueId = await seedIssue(database, owner, workspace.id)
  await assignTaskEnvironment(database, owner, workspace.id, [issueId], env.id)
  await assert.rejects(store.rollbackProjectSetup(owner, request), { code: 'projectResourceConflict' })
  const reached = await store.listProjectSetupVersions(owner, scope)
  assert.equal(reached.totalTasks, 1)
  assert.notEqual(reached.bindingSnapshot, request.bindingSnapshot)
  const replacementTask = await seedIssue(database, owner, workspace.id)
  await database.query('DELETE FROM workspace_task_environments WHERE "issueId"=$1', [issueId])
  await assignTaskEnvironment(database, owner, workspace.id, [replacementTask], env.id)
  await assert.rejects(store.rollbackProjectSetup(owner, { ...request, bindingSnapshot: reached.bindingSnapshot }), { code: 'projectResourceConflict' })
  const currentReach = await store.listProjectSetupVersions(owner, scope)
  assert.equal(currentReach.totalTasks, reached.totalTasks)
  const applied = await store.rollbackProjectSetup(owner, { ...request, bindingSnapshot: currentReach.bindingSnapshot })
  assert.deepEqual(applied, { id: env.id, revision: 3 })
  const stored = (await database.query('select name,configuration from workspace_environments where id=$1', [env.id])).rows[0]
  assert.equal(stored.name, 'Current name')
  assert.equal(stored.configuration.runtime, 'local')
  assert.deepEqual(stored.configuration.variables, { CURRENT_VALUE: 'now' })
  assert.deepEqual(stored.configuration.setup, { command: 'node --version', copyFiles: ['fixture.txt'], approved: false })
  await assert.rejects(store.rollbackProjectSetup(owner, { ...request, bindingSnapshot: reached.bindingSnapshot }), { code: 'projectResourceConflict' })
  assert.equal((await database.query("select count(*)::integer count from workspace_resource_events where kind='environment.setup_restored' and \"resourceId\"=$1", [env.id])).rows[0].count, 1)

  await t.test('a personal environment\'s history is its owner\'s alone', async () => {
    const mine = await store.saveEnvironment(member, { workspaceId: workspace.id, name: 'Mine', scope: 'personal', configuration: {
      setup: { copyFiles: [], command: 'echo one', approved: true } } })
    await store.saveEnvironment(member, { workspaceId: workspace.id, id: mine.id, revision: 1, name: 'Mine', configuration: {
      setup: { copyFiles: [], command: 'echo two', approved: true } } })
    const own = await store.listProjectSetupVersions(member, { workspaceId: workspace.id, environmentId: mine.id })
    await assert.rejects(store.listProjectSetupVersions(owner, { workspaceId: workspace.id, environmentId: mine.id }), { code: 'projectEnvironmentUnavailable' },
      'an administrator cannot read a member\'s personal environment')
    await assert.rejects(store.rollbackProjectSetup(owner, { workspaceId: workspace.id, environmentId: mine.id, revision: 2, version: 1, bindingSnapshot: own.bindingSnapshot }),
      { code: 'projectEnvironmentUnavailable' })
    assert.deepEqual(await store.rollbackProjectSetup(member, { workspaceId: workspace.id, environmentId: mine.id, revision: 2, version: 1, bindingSnapshot: own.bindingSnapshot }),
      { id: mine.id, revision: 3 })
  })

  await database.query("update mikka_workspace_members set status='suspended' where \"workspaceId\"=$1 and \"userId\"=$2", [workspace.id, member])
  await assert.rejects(store.listProjectSetupVersions(member, scope))
})
