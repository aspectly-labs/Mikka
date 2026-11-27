import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dbUrl, seedIssue, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { assignTaskEnvironment } from './helpers/run-project-resources'

test('Environment repository/policy admission on real PostgreSQL', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 3 })
  const resources = await import('../lib/project-resources/store')
  const { withRunProjectExecution } = await import('../lib/project-resources/run-lease')
  const { environmentConfiguration } = await import('../lib/project-resources/contracts')
  const { ActionFailureError } = await import('../lib/action-error')
  const { registerProjectAccess } = await import('../lib/resource-access/projects')
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  t.after(async () => { await Promise.all([connection.end(), pool.end(), workspacePool.end()]) })
  const rejects = (work: Promise<unknown>, code: string) => assert.rejects(work, (error: unknown) => error instanceof ActionFailureError && error.code === code)
  const owner = await seedUser(connection, 'resource-owner'), member = await seedUser(connection, 'resource-member')
  const workspace = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }])
  const issueId = await seedIssue(connection, owner, workspace.id)
  const projectId = randomUUID()
  await connection.query(`insert into workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
    values($1,$2,$3,'Shared project','','','planned','none','','','','','[]',1)`, [projectId, owner, workspace.id])
  await registerProjectAccess(owner, projectId, workspace.id)
  await connection.query('insert into workspace_project_tasks("issueId","projectId","workspaceId") values($1,$2,$3)', [issueId, projectId, workspace.id])
  const repoA = 'v2/github.com/acme/application', repoB = 'v2/github.com/acme/service', repoC = 'v2/github.com/elsewhere/private'
  const request = { userId: owner, workspaceId: workspace.id, issueId, repositoryKey: repoA, baseBranch: 'main', runtime: 'local' as const, harness: 'codex' }
  const admission = (repositoryKey: string | null = repoA) => resources.withProjectExecution({ ...request, repositoryKey }, async snapshot => snapshot)

  await t.test('a task without 环境 inherits existing authorization without an environment becoming a grant', async () => {
    const value = await admission(repoC)
    assert.equal(value.projectId, projectId)
    assert.equal(value.repositoryKey, repoC)
    assert.equal(value.policyRevision, 0)
    assert.equal(value.environment, null)
    assert.equal(value.repositoryClone, undefined, 'without an environment nothing is recorded as cloned')
  })
  let environmentId: string
  await t.test('environment stores reusable configuration and validates existing references', async () => {
    assert.equal(environmentConfiguration.safeParse({ variables: { PATH: '/untrusted' } }).success, false)
    await rejects(resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Bad reference', configuration: { secretIds: [randomUUID()] } }), 'projectEnvironmentUnavailable')
    await rejects(resources.saveEnvironment(member, { workspaceId: workspace.id, name: 'No permission', configuration: {} }), 'workspaceAccessDenied')
    await assert.rejects(resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Two primaries', configuration: {},
      repositories: [{ key: repoA, primary: true }, { key: repoB, primary: true }] }), 'at most one 主仓库')
    await assert.rejects(resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Duplicate rows', configuration: {},
      repositories: [{ key: repoA }, { key: repoA, clone: 'demand' }] }))
    const environment = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Tests', configuration: { variables: { FEATURE_MODE: 'test' }, runtime: 'local', harness: 'codex',
      setup: { copyFiles: [], command: 'node --version', approved: true } },
    repositories: [{ key: repoA, clone: 'start', baseBranch: 'develop', primary: true }, { key: repoB, clone: 'start' }] })
    environmentId = environment.id
    assert.equal(environment.revision, 1)
    const listed = (await resources.listProjectResources(owner, workspace.id)).environments.find(row => row.id === environmentId)!
    assert.deepEqual(listed.configuration.repositoryKeys, [repoA, repoB], 'repositoryKeys stays the start rows for older readers')
    assert.deepEqual(listed.repositories, [{ key: repoA, clone: 'start', baseBranch: 'develop', primary: true }, { key: repoB, clone: 'start', baseBranch: null, primary: false }])
    assert.equal(listed.scope, 'workspace')
    await rejects(resources.listProjectResources({ id: owner, [tokenWorkspace]: other.id }, workspace.id, projectId), 'workspaceAccessDenied')
    await assert.rejects(assignTaskEnvironment(connection, owner, other.id, [issueId], environment.id), { code: 'projectEnvironmentUnavailable' })
  })
  await t.test('a migrated branch-only task uses its original branch without choosing an environment', async () => {
    await connection.query('insert into workspace_task_legacy_repository_branches ("issueId","workspaceId","repositoryKey","baseBranch") values ($1,$2,$3,$4)', [issueId, workspace.id, repoA, 'release'])
    assert.equal((await admission()).baseBranch, 'release')
    assert.equal((await admission()).environment, null)
    const botId = randomUUID()
    await connection.query('insert into bots (id,"workspaceId","ownerId",name,"environmentId") values($1,$2,$3,$4,$5)', [botId, workspace.id, owner, 'Migration Bot', environmentId])
    assert.equal((await resources.withProjectExecution({ ...request, botId }, async snapshot => snapshot)).baseBranch, 'release')
    await withRunProjectExecution({ ...request, botId, baseBranch: 'release' }, undefined, async () => undefined)

  })
  await t.test('the task\'s environment, its repository rows and the Workspace policy form the admission', async () => {
    await assignTaskEnvironment(connection, owner, workspace.id, [issueId], environmentId)
    const value = await admission()
    assert.equal(value.baseBranch, 'develop', 'the environment row\'s base branch is frozen instead of the device default')
    assert.equal(value.repositoryClone, 'start')
    assert.equal(value.environment?.id, environmentId)
    assert.equal(value.environment?.variables.FEATURE_MODE, 'test')
    assert.equal(value.environment?.scope, 'workspace')
    assert.equal((await admission(repoB)).repositoryKey, repoB)
    const onDemand = await admission(repoC)
    assert.deepEqual([onDemand.repositoryKey, onDemand.repositoryClone, onDemand.baseBranch, onDemand.environment?.id], [repoC, 'demand', 'main', environmentId],
      'a repository outside the environment is admitted by the workspace policy and cloned on demand')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 0, mode: 'restricted', repositoryKeys: [repoA, repoB, repoC] })
    await rejects(admission('v2/github.com/elsewhere/blocked'), 'projectRepositoryDenied')
    assert.equal((await admission(repoC)).repositoryClone, 'demand', 'the policy, not the environment, admits on-demand repositories')
    assert.equal((await admission()).policyRevision, 1)
    await rejects(resources.withProjectExecution({ ...request, runtime: 'cloud' }, async value => value), 'projectEnvironmentUnavailable')
    await rejects(resources.withProjectExecution({ ...request, harness: 'claude_code' }, async value => value), 'projectEnvironmentUnavailable')
  })
  await t.test('the retired Project default stays readable for one release, Organization-attached reads included', async () => {
    await connection.query('insert into workspace_project_environments("projectId","workspaceId","environmentId","isDefault") values($1,$2,$3,true)', [projectId, workspace.id, environmentId])
    assert.deepEqual(await resources.readProjectEnvironmentVariable(owner, { workspaceId: workspace.id, projectId, name: 'FEATURE_MODE' }), { name: 'FEATURE_MODE', value: 'test' })
    assert.equal(await resources.readProjectEnvironmentVariable(owner, { workspaceId: workspace.id, projectId, name: 'UNCONFIGURED' }), null)
    const personal = await resources.saveEnvironment(member, { workspaceId: workspace.id, name: 'Member variables', scope: 'personal',
      configuration: { variables: { FEATURE_MODE: 'private' } } })
    await connection.query('UPDATE workspace_project_environments SET "environmentId"=$1 WHERE "projectId"=$2', [personal.id, projectId])
    assert.equal(await resources.readProjectEnvironmentVariable(owner, { workspaceId: workspace.id, projectId, name: 'FEATURE_MODE' }), null)
    await connection.query('UPDATE workspace_project_environments SET "environmentId"=$1 WHERE "projectId"=$2', [environmentId, projectId])
    const governance = await import('../lib/governance/organizations')
    const { rows: [user] } = await connection.query('select id,name,email from "user" where id=$1', [owner])
    const org = await governance.createOrganization(user, { name: 'Environment variable scope' })
    const input = { organizationId: org.id, projectId, name: 'FEATURE_MODE' }
    await governance.attachOrganizationWorkspace(org.id, workspace.id, owner)
    assert.deepEqual(await resources.readOrganizationProjectEnvironmentVariable(owner, input), { name: 'FEATURE_MODE', value: 'test' })
    const { GovernanceError } = await import('../lib/governance/errors')
    const missing = (error: unknown) => error instanceof GovernanceError && error.detail === 'not_found'
    await assert.rejects(resources.readOrganizationProjectEnvironmentVariable(member, input), missing)
    await governance.addOrganizationMember(org.id, owner, { userId: member, role: 'member' })
    assert.deepEqual(await resources.readOrganizationProjectEnvironmentVariable(member, input), { name: 'FEATURE_MODE', value: 'test' })
    await governance.detachOrganizationWorkspace(org.id, workspace.id, owner)
    await assert.rejects(resources.readOrganizationProjectEnvironmentVariable(owner, input), missing)
    const { saveProjectResources, setProjectDefaultEnvironment } = await import('../app/actions/project-resources')
    const { actAs } = await import('../lib/acting-user')
    assert.equal((await actAs(owner, () => saveProjectResources({ workspaceId: workspace.id, projectId, revision: 1, repositories: [], environmentIds: [], defaultEnvironmentId: null }))).error, 'projectBindingsRetired')
    assert.equal((await actAs(owner, () => setProjectDefaultEnvironment({ workspaceId: workspace.id, projectId, revision: 1, environmentId: null }))).error, 'projectBindingsRetired')
  })
  await t.test('an older editor\'s repositoryKeys keep each saved row and its on-demand rows', async () => {
    const saved = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Rows', configuration: {},
      repositories: [{ key: repoA, baseBranch: 'release', primary: true }, { key: repoC, clone: 'demand', baseBranch: 'trunk' }] })
    const rows = async () => (await resources.listProjectResources(owner, workspace.id)).environments.find(row => row.id === saved.id)!
    assert.deepEqual((await rows()).configuration.repositoryKeys, [repoA])
    const legacy = await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: saved.id, revision: 1, name: 'Rows', configuration: { repositoryKeys: [repoB, repoA] } })
    assert.deepEqual((await rows()).repositories, [
      { key: repoB, clone: 'start', baseBranch: null, primary: false },
      { key: repoA, clone: 'start', baseBranch: 'release', primary: true },
      { key: repoC, clone: 'demand', baseBranch: 'trunk', primary: false },
    ])
    // A row written by an older writer (repositoryKeys only) is read as start rows.
    await connection.query(`update workspace_environments set repositories='[]'::jsonb where id=$1`, [saved.id])
    assert.deepEqual((await rows()).repositories.map(row => [row.key, row.clone]), [[repoB, 'start'], [repoA, 'start']])
    await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: saved.id, revision: legacy.revision, name: 'Rows', configuration: {}, repositories: [] })
    assert.deepEqual([(await rows()).repositories, (await rows()).configuration.repositoryKeys], [[], []], 'a default environment needs no repository')
  })

  await t.test('two tasks in one Workspace select the same repository independently through their environments', async () => {
    const issueA = await seedIssue(connection, owner, workspace.id), issueB = await seedIssue(connection, owner, workspace.id)
    const environmentA = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Repository A',
      configuration: { runtime: 'local', harness: 'codex', variables: { PROJECT_CONTEXT: 'A' } },
      repositories: [{ key: repoA, baseBranch: 'review-a', primary: true }, { key: repoC }] })
    const environmentB = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Repository B',
      configuration: { runtime: 'local', harness: 'codex', variables: { PROJECT_CONTEXT: 'B' } },
      repositories: [{ key: repoA, baseBranch: 'review-b', primary: true }] })
    await assignTaskEnvironment(connection, owner, workspace.id, [issueA], environmentA.id)
    await assignTaskEnvironment(connection, owner, workspace.id, [issueB], environmentB.id)
    const requestA = { ...request, issueId: issueA }, requestB = { ...request, issueId: issueB }
    const frozenA = await resources.withProjectExecution(requestA, async snapshot => snapshot)
    const frozenB = await resources.withProjectExecution(requestB, async snapshot => snapshot)
    assert.deepEqual([frozenA.repositoryKey, frozenA.baseBranch, frozenA.environment?.id, frozenA.environment?.variables.PROJECT_CONTEXT], [repoA, 'review-a', environmentA.id, 'A'])
    assert.deepEqual([frozenB.repositoryKey, frozenB.baseBranch, frozenB.environment?.id, frozenB.environment?.variables.PROJECT_CONTEXT], [repoA, 'review-b', environmentB.id, 'B'])
    const originalSnapshots = JSON.stringify([frozenA, frozenB])
    // Only A's environment changes its branch for repoA.
    await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentA.id, revision: environmentA.revision, name: 'Repository A',
      configuration: { runtime: 'local', harness: 'codex', variables: { PROJECT_CONTEXT: 'A' } },
      repositories: [{ key: repoA, baseBranch: 'review-a-next', primary: true }, { key: repoC }] })
    await rejects(withRunProjectExecution(requestA, frozenA, async () => assert.fail('Task A claimed its changed frozen branch')), 'projectRepositoryDenied')
    assert.equal((await resources.withProjectExecution(requestA, async snapshot => snapshot)).baseBranch, 'review-a-next')
    assert.deepEqual(await resources.withProjectExecution(requestB, async snapshot => snapshot), frozenB, 'B still admits its own repository, branch and Environment')
    assert.equal(await withRunProjectExecution(requestB, frozenB, async () => 'Task B claim'), 'Task B claim')
    assert.equal(JSON.stringify([frozenA, frozenB]), originalSnapshots, 'neither previously frozen selection is rewritten')
  })
  await t.test('snapshot remains immutable across edits; revocation blocks new admissions', async () => {
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 1, mode: 'inherit', repositoryKeys: [] })
    const original = await admission()
    const serialized = JSON.stringify(original)
    let claimed = 0
    await withRunProjectExecution({ ...request, baseBranch: original.baseBranch }, original, async () => { claimed++ })
    assert.equal(claimed, 1)
    assert.equal(await withRunProjectExecution({ ...request, baseBranch: 'a'.repeat(40) }, original, async () => 'candidate checkout'), 'candidate checkout',
      'a Factory candidate SHA does not replace the separately frozen target branch')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 2, mode: 'restricted', repositoryKeys: [repoB] })
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectRepositoryDenied')
    assert.equal(claimed, 1, 'a queued Run is not a grant after repository revocation')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 3, mode: 'restricted', repositoryKeys: [repoA, repoB, repoC] })
    const alternate = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Replacement', configuration: {} })
    await assignTaskEnvironment(connection, owner, workspace.id, [issueId], alternate.id)
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    assert.equal(claimed, 1, 'a changed 环境 never mutates or reinterprets the frozen Environment')
    await assignTaskEnvironment(connection, owner, workspace.id, [issueId], environmentId)
    await withRunProjectExecution({ ...request, baseBranch: original.baseBranch }, original, async () => { claimed++ })
    assert.equal(claimed, 2)
    await rejects(withRunProjectExecution({ ...request, baseBranch: original.baseBranch }, undefined, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    assert.equal(claimed, 2, 'a legacy Run cannot silently acquire a new Environment')
    await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentId, revision: 1, name: 'Renamed',
      configuration: { runtime: 'local', harness: 'codex', variables: { FEATURE_MODE: 'updated' }, repositoryKeys: [repoA, repoB] } })
    assert.equal(JSON.stringify(original), serialized)
    assert.equal((await admission()).environment?.revision, 2)
    assert.equal((await admission()).baseBranch, 'develop', 'an older editor\'s save keeps the row\'s base branch')
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    await rejects(resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentId, revision: 1, name: 'Stale', configuration: {} }), 'projectResourceConflict')
    await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentId, revision: 2, name: 'Renamed', archived: true, configuration: {} })
    await rejects(admission(), 'projectEnvironmentUnavailable')
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    assert.equal(claimed, 2)
    assert.equal(JSON.stringify(original), serialized)
  })
  await t.test('same Git repository in another tenant needs its own policy; unprojected work still works', async () => {
    const otherIssue = await seedIssue(connection, owner, other.id)
    const value = await resources.withProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: repoB }, async snapshot => snapshot)
    assert.equal(value.projectId, null)
    assert.equal(value.policyRevision, 0)
    assert.equal(await withRunProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: repoB }, undefined, async () => 'legacy checkout'), 'legacy checkout')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: other.id, revision: 0, mode: 'restricted', repositoryKeys: [] })
    await rejects(resources.withProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: repoB }, async snapshot => snapshot), 'projectRepositoryDenied')
    await resources.withProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: null }, async snapshot => assert.equal(snapshot.repositoryKey, null))
  })
  await t.test('database foreign keys reject cross-tenant environment attachment', async () => {
    const personal = await seedPersonalWorkspace(connection, owner)
    assert.ok(personal)
    await assert.rejects(connection.query(`insert into workspace_task_environments("issueId","workspaceId","environmentId") values($1,$2,$3)`, [randomUUID(), personal, environmentId]), { code: '23503' })
    await assert.rejects(connection.query(`update workspace_environments set scope='personal',"ownerId"=null where id=$1`, [environmentId]), { code: '23514' }, 'a personal environment always has an owner')
  })
  await t.test('completed membership revocation cannot reuse a previously read configuration', async () => {
    await connection.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [other.id, owner])
    await rejects(resources.listProjectResources(owner, other.id), 'workspaceAccessDenied')
    await rejects(resources.withProjectExecution({ ...request, workspaceId: other.id }, async snapshot => snapshot), 'workspaceAccessDenied')
  })
})
