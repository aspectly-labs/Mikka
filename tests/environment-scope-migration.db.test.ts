import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { ENVIRONMENT_SCOPE_LIMITS, setLocalLimits } from '../scripts/migration-steps.mjs'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

const migration = () => readFile(new URL('../drizzle/20261125223723_environment_scope_and_task_environments.sql', import.meta.url), 'utf8')

// Replays the expand migration over Project-bound fixtures inside one rolled-back transaction.
test('the environment migration moves unambiguous Project data onto task 环境 and environment repository rows', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 1 })
  t.after(() => pool.end())
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // The backfill runs under the same limits migrate.mjs sets on its workspace connection.
    await setLocalLimits(client, ENVIRONMENT_SCOPE_LIMITS.migration)
    const db = client as unknown as Pool
    const owner = await seedUser(db, 'environment-migration')
    const workspace = await seedWorkspace(db, owner, [{ userId: owner, role: 'admin' }])
    const ws = workspace.id
    const repoA = 'v2/github.com/acme/a', repoB = 'v2/github.com/acme/b', repoC = 'v2/github.com/acme/c'
    const environment = async (name: string, repositoryKeys: string[]) => {
      const id = randomUUID()
      await client.query(`INSERT INTO workspace_environments(id,"workspaceId",name,configuration,revision,"createdBy","updatedBy") VALUES($1,$2,$3,$4,1,$5,$5)`,
        [id, ws, name, JSON.stringify({ runtime: 'any', harness: 'any', variables: {}, secretIds: [], repositoryKeys }), owner])
      return id
    }
    const sharedProjects: Array<{ id: string; workspaceId: string }> = []
    const project = async (bindings: { environmentId: string; isDefault: boolean }[], repositories: { key: string; baseBranch: string | null; environmentId: string | null; isPrimary: boolean }[], tasks: string[]) => {
      const id = randomUUID()
      await client.query(`INSERT INTO workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
        VALUES($1,$2,$3,'Migration fixture','','','planned','none','','','','','[]',1)`, [id, owner, ws])
      for (const binding of bindings) await client.query('INSERT INTO workspace_project_environments("projectId","workspaceId","environmentId","isDefault") VALUES($1,$2,$3,$4)', [id, ws, binding.environmentId, binding.isDefault])
      for (const repo of repositories) await client.query('INSERT INTO workspace_project_repositories("projectId","workspaceId","repositoryKey","baseBranch","environmentId","isPrimary") VALUES($1,$2,$3,$4,$5,$6)',
        [id, ws, repo.key, repo.baseBranch, repo.environmentId, repo.isPrimary])
      for (const issueId of tasks) await client.query('INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId") VALUES($1,$2,$3)', [issueId, id, ws])
      sharedProjects.push({ id, workspaceId: ws })
      return id
    }
    const [defaulted, onlyBound, ambiguous, unbound, kept] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const e1 = await environment('Default with repositories', [repoA, repoB])
    const e2 = await environment('Only bound, any repository', [])
    const e3a = await environment('Ambiguous A', []), e3b = await environment('Ambiguous B', [])
    const e4 = await environment('Disagreeing Projects', [repoA, repoB])
    await project([{ environmentId: e1, isDefault: true }], [{ key: repoA, baseBranch: 'develop', environmentId: null, isPrimary: true },
      { key: repoC, baseBranch: 'next', environmentId: null, isPrimary: false }], [defaulted, kept])
    await project([{ environmentId: e2, isDefault: false }], [{ key: repoC, baseBranch: 'feature-x', environmentId: null, isPrimary: false }], [onlyBound])
    await project([{ environmentId: e3a, isDefault: false }, { environmentId: e3b, isDefault: false }], [], [ambiguous])
    await project([], [{ key: repoA, baseBranch: 'old', environmentId: null, isPrimary: true }], [unbound])
    await project([{ environmentId: e4, isDefault: true }], [{ key: repoA, baseBranch: 'one', environmentId: null, isPrimary: true }], [])
    await project([{ environmentId: e4, isDefault: true }], [{ key: repoA, baseBranch: 'two', environmentId: null, isPrimary: false }, { key: repoB, baseBranch: null, environmentId: null, isPrimary: true }], [])
    // A person's own choice made after the release is never overwritten by a replay.
    await client.query('INSERT INTO workspace_task_environments("issueId","workspaceId","environmentId","updatedBy") VALUES($1,$2,$3,$4)', [kept, ws, e2, owner])

    const withheld = await environment('Existing shared environment', [])
    const privateTask = randomUUID()
    await project([{ environmentId: withheld, isDefault: true }], [{ key: repoC, baseBranch: 'private', environmentId: null, isPrimary: true }], [privateTask])
    sharedProjects.pop()
    const hundred = Array.from({length:100}, (_, i) => 'v2/github.com/acme/migration-' + i)
    const full = await environment('Full', hundred)
    await project([{ environmentId: full, isDefault: true }], [
      { key: hundred[0], baseBranch: 'release', environmentId: null, isPrimary: true },
      { key: repoC, baseBranch: 'overflow', environmentId: null, isPrimary: false },
    ], [])
    await client.query("SELECT set_config('mikka.shared_project_backfill',$1,true)",[JSON.stringify(sharedProjects)])
    const sql = await migration()
    await client.query(sql)
    assert.deepEqual((await client.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0],
      { lock: '5s', statement: '1min' }, 'the migration ran with bounded lock waits and statements')
    const taskEnvironments = async () => Object.fromEntries((await client.query<{ issueId: string; environmentId: string; updatedBy: string | null }>(
      'SELECT "issueId","environmentId","updatedBy" FROM workspace_task_environments WHERE "workspaceId"=$1', [ws])).rows.map(row => [row.issueId, [row.environmentId, row.updatedBy]]))
    assert.deepEqual(await taskEnvironments(), {
      [defaulted]: [e1, null],
      [onlyBound]: [e2, null],
      [kept]: [e2, owner],
      [privateTask]: [withheld, null],
    }, 'the default, else the only bound environment; ambiguous and unbound tasks get none')
    assert.deepEqual((await client.query('select "repositoryKey","baseBranch" from workspace_task_legacy_repository_branches where "workspaceId"=$1 and "issueId"=$2',[ws,unbound])).rows,
      [{ repositoryKey: repoA, baseBranch: 'old' }])
    const repositories = async (id: string) => (await client.query('SELECT repositories,revision,scope,"ownerId" FROM workspace_environments WHERE id=$1', [id])).rows[0]
    assert.deepEqual(await repositories(e1), { revision: 1, scope: 'workspace', ownerId: null, repositories: [
      { key: repoA, clone: 'start', baseBranch: 'develop', primary: true },
      { key: repoB, clone: 'start', baseBranch: null, primary: false },
      { key: repoC, clone: 'demand', baseBranch: 'next', primary: false },
    ] }, 'start rows follow repositoryKeys and take the Project branch and 主仓库; the revision is unchanged')
    assert.deepEqual((await repositories(e2)).repositories, [{ key: repoC, clone: 'demand', baseBranch: 'feature-x', primary: false }],
      'an environment that admitted any repository keeps its bound repositories as on-demand rows')
    assert.deepEqual((await repositories(withheld)).repositories, [])
    assert.equal((await client.query('SELECT "baseBranch" FROM workspace_task_legacy_repository_branches WHERE "issueId"=$1', [privateTask])).rows[0].baseBranch, 'private')
    const fullRows = (await repositories(full)).repositories
    assert.equal(fullRows.length, 100)
    assert.equal(fullRows[0].baseBranch, 'release')
    assert.deepEqual((await repositories(e3a)).repositories, [])
    assert.deepEqual((await repositories(e4)).repositories, [
      { key: repoA, clone: 'start', baseBranch: null, primary: false },
      { key: repoB, clone: 'start', baseBranch: null, primary: false },
    ], 'disagreeing branches and two primaries carry over as neither')
    const before = JSON.stringify([await taskEnvironments(), await repositories(e1), await repositories(e2), await repositories(e4)])
    await client.query(sql)
    assert.equal(JSON.stringify([await taskEnvironments(), await repositories(e1), await repositories(e2), await repositories(e4)]), before, 'the migration replays without change')
    await client.query('SAVEPOINT scope_check')
    await assert.rejects(client.query(`UPDATE workspace_environments SET scope='personal' WHERE id=$1`, [e1]), { code: '23514' }, 'a personal environment needs an owner')
    await client.query('ROLLBACK TO SAVEPOINT scope_check')
    await assert.rejects(client.query(`UPDATE workspace_environments SET scope='team' WHERE id=$1`, [e1]), { code: '23514' })
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})

// A long read of workspace_environments must not leave the migration waiting forever for
// ACCESS EXCLUSIVE, nor a held ACL transaction stay open after the runner goes quiet.
test('the environment migration gives up on a blocked lock and the ACL hold has an idle bound', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  t.after(() => pool.end())
  const [reader, migrator, acl] = [await pool.connect(), await pool.connect(), await pool.connect()]
  try {
    await reader.query('BEGIN')
    await reader.query('SELECT 1 FROM workspace_environments LIMIT 1')
    await migrator.query('BEGIN')
    await setLocalLimits(migrator, ENVIRONMENT_SCOPE_LIMITS.migration)
    const started = Date.now()
    await assert.rejects(migrator.query(await migration()), { code: '55P03' }, 'lock_timeout ends the wait behind the reader')
    assert.ok(Date.now() - started < 30_000)
    await acl.query('BEGIN')
    await setLocalLimits(acl, ENVIRONMENT_SCOPE_LIMITS.acl)
    assert.deepEqual((await acl.query("SELECT current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle")).rows[0],
      { lock: '5s', idle: '15min' })
    await acl.query('ROLLBACK')
    assert.equal((await acl.query("SELECT current_setting('idle_in_transaction_session_timeout') AS idle")).rows[0].idle, '0', 'SET LOCAL ends with the transaction')
  } finally {
    await Promise.allSettled([reader.query('ROLLBACK'), migrator.query('ROLLBACK')])
    for (const client of [reader, migrator, acl]) client.release()
  }
})
