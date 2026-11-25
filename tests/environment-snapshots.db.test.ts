import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { repositorySeed, eligibleConfiguration } from '../lib/project-resources/environment-snapshot-contract'
import { environmentConfiguration } from '../lib/project-resources/contracts'

test('prebuilt GitHub checkouts use the daemon cache identity and credential-bearing setup is never captured', () => {
  const key = 'v2/github.com/acme/test'
  assert.deepEqual(repositorySeed(key.toUpperCase()), {
    remote: 'https://github.com/acme/test.git',
    directory: '/home/user/.mikka/worker/repos/v2/' + createHash('sha256').update(key).digest('hex'),
  })
  assert.throws(() => repositorySeed('v2/github.com/acme/..'))
  assert.throws(() => repositorySeed('v2/example.invalid/acme/test'))
  const config = environmentConfiguration.parse({
    secretIds: [randomUUID()],
    setup: { approved: true, command: 'test -n "$SECRET"', copyFiles: [] },
  })
  assert.equal(eligibleConfiguration(config, [], { mode: 'inherit', repositoryKeys: [] }), false)
})

test(
  'environment snapshot selection requires the same installation, revision, template and worker, retains last good after failure, and rechecks permissions',
  { skip: !dbUrl },
  async (t) => {
    const fixture = new Pool({ connectionString: dbUrl })
    t.after(() => fixture.end())
    const old = {
      flags: process.env.MIKKA_FLAG_OVERRIDES,
      env: process.env.NODE_ENV,
      sha: process.env.MIKKA_CLOUD_WORKER_SHA,
      team: process.env.E2B_TEAM_ID,
      key: process.env.E2B_API_KEY,
    }
    process.env.NODE_ENV = 'test'
    process.env.E2B_TEAM_ID = 'snapshot-fixture-team'
    process.env.E2B_API_KEY = 'fixture-no-provider-requests'
    process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40)
    t.after(() => {
      for (const [key, value] of Object.entries({
        NODE_ENV: old.env,
        E2B_TEAM_ID: old.team,
        E2B_API_KEY: old.key,
        MIKKA_FLAG_OVERRIDES: old.flags,
        MIKKA_CLOUD_WORKER_SHA: old.sha,
      }))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    })
    const { environmentSnapshotScope } = await import('../lib/secrets/e2b-runtime')
    const { saveEnvironment } = await import('../lib/project-resources/store')
    const { buildEnvironmentSnapshot, expireEnvironmentSnapshot } =
      await import('../lib/project-resources/environment-snapshot-build')
    const { readyEnvironmentSnapshot, readEnvironmentSnapshot } =
      await import('../lib/project-resources/environment-snapshots')
    const owner = await seedUser(fixture, 'snapshot-owner'),
      peer = await seedUser(fixture, 'snapshot-peer')
    const ws = await seedWorkspace(fixture, owner, [
      { userId: owner, role: 'admin' },
      { userId: peer, role: 'member' },
    ])
    const { id: environmentId, revision } = await saveEnvironment(owner, {
      workspaceId: ws.id,
      name: 'snapshot',
      configuration: {},
    })
    const input = {
      workspaceId: ws.id,
      userId: owner,
      environmentId,
      revision,
      templateId: 'codex',
    }
    const readInput = {
      workspaceId: ws.id,
      environmentId,
      templateKind: 'codex',
    } as const
    const insert = async (state: string, provider: string | null) => {
      const id = randomUUID()
      await fixture.query(
        `INSERT INTO environment_snapshots(id,"workspaceId","environmentId",revision,"requestedBy","templateKind","templateId","workerSha",state,"providerId","providerScope")
      VALUES($1,$2,$3,1,$4,'codex','codex',$5,$6,$7,$8)`,
        [
          id,
          ws.id,
          environmentId,
          owner,
          process.env.MIKKA_CLOUD_WORKER_SHA,
          state,
          provider,
          environmentSnapshotScope(),
        ],
      )
      return id
    }
    const id = await insert('ready', 'fixture-good')
    process.env.MIKKA_FLAG_OVERRIDES = '{"mikka-environment-snapshots":false}'
    assert.equal(await readyEnvironmentSnapshot(input), null)
    assert.deepEqual(await readEnvironmentSnapshot(owner, readInput), {
      enabled: false,
      snapshot: null,
    })
    process.env.MIKKA_FLAG_OVERRIDES = '{"mikka-environment-snapshots":true}'
    const ready = { id, providerId: 'fixture-good' }
    assert.deepEqual(await readyEnvironmentSnapshot(input), ready)
    await fixture.query('UPDATE environment_snapshots SET "repositoryIds"=$2 WHERE id=$1', [id, { revoked: '123' }])
    assert.equal((await readEnvironmentSnapshot(owner, readInput)).snapshot?.state, 'outdated')
    assert.equal(await readyEnvironmentSnapshot(input), null)
    await fixture.query('UPDATE environment_snapshots SET "repositoryIds"=$2 WHERE id=$1', [id, {}])
    const { withTaskWorkspace } = await import('../lib/task-workspace')
    assert.deepEqual(await withTaskWorkspace(owner, ws.id, () => readyEnvironmentSnapshot(input)), ready)
    assert.deepEqual(await readyEnvironmentSnapshot({ ...input, userId: peer }), ready)
    process.env.E2B_TEAM_ID = 'different-snapshot-install'
    assert.equal(await readyEnvironmentSnapshot(input), null)
    process.env.E2B_TEAM_ID = 'snapshot-fixture-team'
    for (const changed of [{ revision: 2 }, { templateId: 'claude' }])
      assert.equal(await readyEnvironmentSnapshot({ ...input, ...changed }), null)
    process.env.MIKKA_CLOUD_WORKER_SHA = 'b'.repeat(40)
    assert.equal(await readyEnvironmentSnapshot(input), null)
    process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40)
    await fixture.query(
      'INSERT INTO workspace_computer_policies ("workspaceId",cli_run_policy) VALUES($1,$2) ON CONFLICT ("workspaceId") DO UPDATE SET cli_run_policy=excluded.cli_run_policy',
      [ws.id, { networkAllow: ['example.org'] }],
    )
    assert.equal(await readyEnvironmentSnapshot(input), null)
    await fixture.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [ws.id])
    // No E2B key is configured for this fixture. The real builder records its failure
    // without contacting the provider or replacing the last successful image.
    const attempt = await insert('building', null)
    delete process.env.E2B_API_KEY
    await buildEnvironmentSnapshot(attempt)
    process.env.E2B_API_KEY = 'fixture-no-provider-requests'
    const failed = (await readEnvironmentSnapshot(owner, readInput)).snapshot
    assert.equal(failed?.state, 'failed')
    assert.equal(failed?.logTail, 'configuration\ncreate')
    assert.deepEqual(await readyEnvironmentSnapshot(input), ready)
    const { cleanupOwnerEnvironmentSnapshots } = await import('../lib/project-resources/environment-snapshot-build')
    // Removing the builder from a surviving workspace preserves its shared image.
    await cleanupOwnerEnvironmentSnapshots(owner, [])
    assert.deepEqual(await readyEnvironmentSnapshot({ ...input, userId: peer }), ready)
    assert.equal(
      (await fixture.query('SELECT "requestedBy" FROM environment_snapshots WHERE id=$1', [id])).rows[0].requestedBy,
      null,
    )
    await fixture.query('UPDATE environment_snapshots SET "expiresAt"=now() WHERE id IN ($1,$2)', [id, attempt])
    assert.equal(await readyEnvironmentSnapshot(input), null)
    await expireEnvironmentSnapshot(attempt)
    assert.equal((await fixture.query('SELECT id FROM environment_snapshots WHERE id=$1', [attempt])).rowCount, 0)
  },
)

test(
  'account deletion keeps receipts on provider failure, drains only removed environments, and fences new builds',
  { skip: !dbUrl },
  async (t) => {
    const db = new Pool({ connectionString: dbUrl })
    t.after(() => db.end())
    const { cleanupOwnerEnvironmentSnapshots } = await import('../lib/project-resources/environment-snapshot-build')
    const owner = randomUUID(),
      peer = randomUUID(),
      source = randomUUID()
    const insert = (user: string) =>
      db.query(
        `INSERT INTO environment_snapshots
    (id,"workspaceId","environmentId",revision,"requestedBy","templateKind","templateId","workerSha",state,"allocationAttempted","providerScope")
    VALUES($1,$2,$3,1,$4,'codex','codex','test','failed',true,'install-fixture')`,
        [randomUUID(), randomUUID(), randomUUID(), user],
      )
    await insert(owner)
    await insert(peer)
    await db.query('INSERT INTO account_deletion_guards ("subjectId","jobId") VALUES($1,$2)', [owner, randomUUID()])
    await assert.rejects(insert(owner), { code: '55000' })
    const killed: string[] = []
    const provider = {
      async findSandbox(user: string) {
        assert.equal(user, 'install-fixture')
        return source
      },
      async listSnapshots(id: string, user: string) {
        assert.equal(user, 'install-fixture')
        assert.equal(id, source)
        return [{ snapshotId: 'image', names: [] }]
      },
      async deleteSnapshot(id: string, user: string) {
        assert.equal(id, 'image')
        assert.equal(user, 'install-fixture')
        return true
      },
      async kill(id: string, user: string) {
        assert.equal(user, 'install-fixture')
        killed.push(id)
      },
    }
    await assert.rejects(
      cleanupOwnerEnvironmentSnapshots(owner, [], {
        ...provider,
        async deleteSnapshot() {
          throw Error('retry')
        },
      }),
      /retry/,
    )
    const count = async (user: string) =>
      (await db.query('SELECT id FROM environment_snapshots WHERE "requestedBy"=$1', [user])).rowCount
    assert.equal(await count(owner), 1)
    await cleanupOwnerEnvironmentSnapshots(owner, [], provider)
    assert.equal(await count(owner), 0)
    assert.equal(await count(peer), 1)
    assert.deepEqual(killed, [source])
  },
)
