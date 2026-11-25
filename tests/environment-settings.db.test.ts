import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedIssue, seedProject, seedProjectTasks, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('an Environment keeps its default machine size; a run that names it gets it and keeps it as chosen', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const store = await import('../lib/project-resources/store')
  // The suite's last test closes the shared application pools.
  t.after(() => fixture.end())
  const owner = await seedUser(fixture, 'environment-size-owner')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
  const issueId = await seedIssue(fixture, owner, workspace.id)
  const configuration = { setup: { copyFiles: [], command: 'echo size', approved: true } }
  const size = async (id: string) => (await store.listProjectResources(owner, workspace.id)).environments.find(row => row.id === id)?.defaultMachineSize
  const saved = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Large', configuration, defaultMachineSize: 'standard-4-16' })
  assert.equal(await size(saved.id), 'standard-4-16')
  const renamed = await store.saveEnvironment(owner, { workspaceId: workspace.id, id: saved.id, revision: saved.revision, name: 'Large runs', configuration })
  assert.equal(await size(saved.id), 'standard-4-16', 'a save without the size keeps it')
  await assert.rejects(store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Bad', configuration, defaultMachineSize: 'huge' as never }))
  const snapshot = await store.withProjectExecution({ userId: owner, workspaceId: workspace.id, issueId, repositoryKey: null, baseBranch: null, runtime: 'cloud', harness: 'codex', environmentId: saved.id }, async value => value)
  assert.deepEqual([snapshot.environment?.id, snapshot.environment?.chosen, snapshot.environment?.defaultMachineSize], [saved.id, true, 'standard-4-16'])
  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: saved.id, revision: renamed.revision, name: 'Large runs', configuration, defaultMachineSize: null })
  assert.equal(await size(saved.id), null, 'null goes back to Mikka’s default')
})

test('a task\'s 环境 editor follows task steering, environment scope and revisions, and selects the admitted environment', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const store = await import('../lib/project-resources/store')
  const { setTaskEnvironment, readTaskEnvironments } = await import('../lib/project-resources/task-environment')
  t.after(async () => { await Promise.all([fixture.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(fixture, 'task-environment-owner'), member = await seedUser(fixture, 'task-environment-member')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedTeam(fixture, workspace.id, owner)
  const projectId = await seedProject(fixture, owner, [{ teamId: team.id, workspaceId: workspace.id }])
  const issueId = await seedIssue(fixture, owner, workspace.id)
  await seedProjectTasks(fixture, projectId, [issueId])
  const repositoryKey = 'v2/github.com/mikka-ci/environment-settings'
  const first = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Repository', configuration: { setup: { copyFiles: [], command: 'echo repository', approved: true } },
    repositories: [{ key: repositoryKey, clone: 'start', baseBranch: 'release', primary: true }] })
  const second = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Project', configuration: { setup: { copyFiles: [], command: 'echo project', approved: true } } })
  const revision = async () => Number((await fixture.query('SELECT revision FROM issues WHERE id=$1', [issueId])).rows[0].revision)
  const choose = async (environmentId: string | null, user = owner, tenant = workspace.id, at?: number) =>
    setTaskEnvironment({ id: user }, { workspaceId: tenant, issueId, revision: at ?? await revision(), environmentId })
  const admission = (key: string | null, userId = owner) => store.withProjectExecution({ userId, workspaceId: workspace.id, issueId,
    repositoryKey: key, baseBranch: 'main', runtime: 'local', harness: 'codex' }, async snapshot => snapshot)

  assert.equal((await admission(repositoryKey)).environment, null, 'a task with no 环境 admits no environment')
  const stranger = await seedUser(fixture, 'task-environment-stranger')
  await assert.rejects(choose(second.id, stranger), { code: 'workspaceAccessDenied' })
  // Steering the task is the right to change its 环境; the environment must be one the chooser may use.
  const ownersOwn = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Owner only', scope: 'personal', configuration: {} })
  await assert.rejects(choose(ownersOwn.id, member), { code: 'projectEnvironmentUnavailable' }, 'someone else\'s 仅我 environment cannot be chosen')
  const membersOwn = await store.saveEnvironment(member, { workspaceId: workspace.id, name: 'Member only', scope: 'personal', configuration: {} })
  await choose(membersOwn.id, member)
  assert.equal((await admission(repositoryKey, member)).environment?.id, membersOwn.id)
  await assert.rejects(admission(repositoryKey, owner), { code: 'projectEnvironmentUnavailable' }, 'a personal environment admits only its owner\'s runs')
  assert.deepEqual(await readTaskEnvironments({ id: owner }, { workspaceId: workspace.id, issueIds: [issueId] }),
    [{ issueId, environmentId: membersOwn.id, environment: null }], 'its name stays private')
  await choose(null, member)
  await assert.rejects(choose(null, owner, other.id), { code: 'issueNotFound' }, 'a task of another workspace')
  await assert.rejects(choose(randomUUID()), { code: 'projectEnvironmentUnavailable' })
  const foreign = await store.saveEnvironment(owner, { workspaceId: other.id, name: 'Other tenant', configuration: {} })
  await assert.rejects(choose(foreign.id), { code: 'projectEnvironmentUnavailable' })
  const before = await revision()
  await assert.rejects(choose(first.id, owner, workspace.id, before - 1 || 99), { code: 'issueOutdated' })
  assert.deepEqual(await choose(first.id), { revision: before + 1, environmentId: first.id })
  assert.deepEqual(await choose(first.id), { revision: before + 1, environmentId: first.id }, 'choosing the same 环境 is not a new revision')

  const frozen = await admission(repositoryKey)
  assert.equal(frozen.projectId, projectId, 'the Project still contains the task')
  assert.deepEqual([frozen.environment?.id, frozen.environment?.chosen, frozen.baseBranch, frozen.repositoryClone], [first.id, undefined, 'release', 'start'])
  const outside = await admission(`${repositoryKey}-other`)
  assert.deepEqual([outside.environment?.id, outside.baseBranch, outside.repositoryClone], [first.id, 'main', 'demand'], 'a repository outside the environment is cloned on demand')
  assert.equal((await admission(null)).environment?.id, first.id, 'an environment with repositories also admits work that names none')
  const chosen = await store.withProjectExecution({ userId: owner, workspaceId: workspace.id, issueId, repositoryKey, baseBranch: 'main', runtime: 'local', harness: 'codex', environmentId: second.id }, async snapshot => snapshot)
  assert.deepEqual([chosen.environment?.id, chosen.environment?.chosen], [second.id, true], 'the request\'s choice wins over the task\'s 环境')

  assert.deepEqual(await choose(second.id), { revision: before + 2, environmentId: second.id })
  assert.equal((await admission(repositoryKey)).environment?.id, second.id)
  assert.equal(frozen.environment?.id, first.id, 'changing the 环境 never mutates a frozen snapshot')
  const views = await readTaskEnvironments({ id: member }, { workspaceId: workspace.id, issueIds: [issueId] })
  assert.deepEqual(views, [{ issueId, environmentId: second.id, environment: { id: second.id, name: 'Project', scope: 'workspace', mine: false } }])
  const events = await fixture.query(`SELECT detail FROM workspace_resource_events WHERE kind='task_environment.changed' AND "resourceId"=$1 ORDER BY "createdAt"`, [issueId])
  assert.deepEqual(events.rows.map(row => row.detail), [{ environmentId: membersOwn.id, previous: null }, { environmentId: null, previous: membersOwn.id },
    { environmentId: first.id, previous: null }, { environmentId: second.id, previous: first.id }])

  const simultaneous = await Promise.allSettled([choose(first.id, owner, workspace.id, before + 2), choose(null, owner, workspace.id, before + 2)])
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(((simultaneous.find(result => result.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code, 'issueOutdated')
  assert.equal((await fixture.query('SELECT count(*)::int AS n FROM workspace_task_environments WHERE "issueId"=$1', [issueId])).rows[0].n <= 1, true)

  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: second.id, revision: 1, name: 'Project', configuration: {}, archived: true })
  await assert.rejects(choose(second.id), { code: 'projectEnvironmentUnavailable' }, 'an archived environment cannot be chosen')
  await choose(first.id)
  const settled = await revision()
  assert.deepEqual(await choose(null), { revision: settled + 1, environmentId: null })
  assert.equal((await admission(repositoryKey)).environment, null)
  await fixture.query('UPDATE workspace_projects SET "archivedAt"=now(),"archivedBy"=$2 WHERE id=$1', [projectId, owner])
  await assert.rejects(admission(repositoryKey), { code: 'projectArchived' }, 'an archived Project still holds its tasks\' runs')
  await fixture.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner])
  await assert.rejects(choose(first.id), { code: 'workspaceAccessDenied' })
})
