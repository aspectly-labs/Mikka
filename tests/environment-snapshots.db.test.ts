import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { repositorySeed, eligibleConfiguration } from '../lib/project-resources/environment-snapshot-contract'
import { environmentConfiguration, portableEnvironmentDefinition, PORTABLE_ENVIRONMENT_BASE } from '../lib/project-resources/contracts'

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

test('historical environment definitions preserve approved setup, variables and encrypted secret references', () => {
  const setup = { approved: true, command: 'npm ci', copyFiles: ['.npmrc'] }
  const variables = { BUILD_MODE: 'production', KEEP_EMPTY: '' }
  const secretIds = [randomUUID()]
  // Match the persisted definition from before baseImage was introduced.
  const historical = { runtime: 'cloud', setup, variables, secretIds }
  const parsed = environmentConfiguration.parse(JSON.parse(JSON.stringify(historical)))
  assert.equal(parsed.baseImage, undefined)
  assert.deepEqual(portableEnvironmentDefinition(parsed), { baseImage: PORTABLE_ENVIRONMENT_BASE, setup, variables, secretIds })
  assert.equal(eligibleConfiguration(parsed, [], { mode: 'inherit', repositoryKeys: [] }), false)
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
    const { abandonEnvironmentSnapshotBuild, buildEnvironmentSnapshot, expireEnvironmentSnapshot } =
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
    assert.equal(await readyEnvironmentSnapshot(input), null)
    assert.notEqual((await readEnvironmentSnapshot(owner, readInput)).snapshot?.state, 'ready')
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

    const templates = Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [
      kind, { templateId: `fixture-${kind}`, baseTemplate: kind, preinstalled: true, models: [] },
    ]))
    const catalogue = {
      version: 1,
      workerSha: process.env.MIKKA_CLOUD_WORKER_SHA,
      templates,
      machineVariants: [
        ...Object.entries(templates).map(([kind, { templateId }]) => ({
          kind, templateId, size: 'medium', cpuCount: 2, memoryMB: 8192,
        })),
        { kind: 'codex', templateId: 'fixture-codex-small', size: 'small', cpuCount: 1, memoryMB: 4096 },
      ],
    }
    const sizedEnv = {
      MIKKA_EDITION: 'cloud',
      E2B_BYO_COMPUTER_TEMPLATE: templates.desktop.templateId,
      E2B_CLAUDE_TEMPLATE: templates.claude.templateId,
      E2B_CODEX_TEMPLATE: templates.codex.templateId,
      MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(catalogue),
    }
    const previous = Object.fromEntries(Object.keys(sizedEnv).map(key => [key, process.env[key]]))
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    Object.assign(process.env, sizedEnv)
    const changeTier = (revision: number, e2bMachineSize?: 'small' | null) =>
      saveEnvironment(owner, {
        id: environmentId, workspaceId: ws.id, name: 'snapshot', revision,
        configuration: e2bMachineSize === undefined ? {} : { e2bMachineSize },
      })
    const selected = await changeTier(revision, 'small')
    const preserved = await changeTier(selected.revision)
    const addSizedReceipt = async (templateId: string, state: 'building' | 'ready', providerId: string | null) => {
      const snapshotId = randomUUID()
      await fixture.query(
        `INSERT INTO environment_snapshots
          (id,"workspaceId","environmentId",revision,"requestedBy","providerScope","templateKind","templateId","workerSha",state,"providerId")
          VALUES($1,$2,$3,$4,$5,$6,'codex',$7,$8,$9,$10)`,
        [snapshotId, ws.id, environmentId, preserved.revision, owner, environmentSnapshotScope(),
          templateId, catalogue.workerSha, state, providerId],
      )
      return snapshotId
    }
    const mediumBuild = await addSizedReceipt('fixture-codex', 'building', null)
    await buildEnvironmentSnapshot(mediumBuild)
    assert.equal((await fixture.query('SELECT state FROM environment_snapshots WHERE id=$1', [mediumBuild])).rows[0].state, 'outdated')
    await addSizedReceipt('fixture-codex', 'ready', 'unexpected-medium-image')
    const sized = await addSizedReceipt('fixture-codex-small', 'ready', 'fixture-small-image')
    const sizedInput = { ...input, revision: preserved.revision, templateId: 'fixture-codex-small' }
    assert.equal((await readEnvironmentSnapshot(owner, readInput)).snapshot?.id, sized)
    assert.equal((await readEnvironmentSnapshot(owner, readInput)).snapshot?.state, 'ready')
    assert.deepEqual(await readyEnvironmentSnapshot(sizedInput), { id: sized, providerId: 'fixture-small-image' })
    assert.equal(await readyEnvironmentSnapshot({ ...sizedInput, templateId: 'fixture-codex' }), null)
    const waiting = await addSizedReceipt('fixture-codex-small', 'building', null)
    const held = await fixture.connect()
    try {
      await held.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        JSON.stringify(['environment-build-slot', environmentSnapshotScope(), ws.id]),
      ])
      const deferred = await buildEnvironmentSnapshot(waiting)
      assert.ok(deferred && typeof deferred === 'object' && 'retryAt' in deferred)
    } finally {
      held.release(true)
    }
    assert.match((await abandonEnvironmentSnapshotBuild(waiting)) ?? '', /^\d{4}-/)
    assert.deepEqual((await fixture.query('SELECT state,"logTail" FROM environment_snapshots WHERE id=$1', [waiting])).rows[0],
      { state: 'failed', logTail: 'queue' })
    const cleared = await changeTier(preserved.revision, null)
    assert.equal((await readEnvironmentSnapshot(owner, readInput)).snapshot?.state, 'outdated')
    assert.equal(await readyEnvironmentSnapshot({ ...sizedInput, revision: cleared.revision }), null)

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

test(
  'locked E2B SDK builds a filesystem-only image, creates independent tasks, and kills unsuccessful builders',
  { skip: !dbUrl },
  async (t) => {
    const { Sandbox } = await import('e2b')
    const { applicationEnvironment } = await import('../cloudflare/api/ingress/environment.mjs')
    const { LOCAL_E2B_KEY } = await import('./fakes/e2b.mjs')
    const { startExternalServices } = await import('./fakes/external-services.mjs')
    const sha = 'd'.repeat(40),
      commit = 'c'.repeat(40)
    const services = await startExternalServices({
      e2b: {
        commands(command: string) {
          if (command.startsWith('bash -s -- '))
            return {
              stdout: 'mikka-official-instance-ready ' + commit + ' ' + sha,
              files: { '/opt/mikka/worker-source-sha': sha },
            }
          if (command === 'prepare-dependencies') return { files: { '/fixture/dependency': 'prepared' } }
          return { exitCode: 0 }
        },
      },
    })
    t.after(() => services.close())
    const projected = applicationEnvironment({ E2B_API_KEY: LOCAL_E2B_KEY, E2B_TEAM_ID: 'sdk-team', PUBLIC_ORIGIN: 'http://localhost' }) as Record<string,string>
    assert.equal(projected.E2B_API_KEY, LOCAL_E2B_KEY)
    assert.equal(projected.E2B_TEAM_ID, 'sdk-team')
    const env = {
      NODE_ENV: 'test',
      MIKKA_EDITION: 'cloud',
      E2B_API_KEY: projected.E2B_API_KEY,
      E2B_TEAM_ID: projected.E2B_TEAM_ID,
      E2B_API_URL: services.e2bOptions.apiUrl,
      E2B_SANDBOX_URL: services.e2bOptions.sandboxUrl,
      E2B_HTTP_VERSION: '1.1',
      HTTPS_PROXY: '',
      https_proxy: '',
      MIKKA_CLOUD_WORKER_SHA: sha,
      MIKKA_CLOUD_WORKER_SOURCE_COMMIT: commit,
      MIKKA_FLAG_OVERRIDES: '{"mikka-environment-snapshots":true}',
    }
    const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)
    t.after(() => {
      for (const [key, value] of Object.entries(original))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    })
    const db = new Pool({ connectionString: dbUrl })
    t.after(() => db.end())
    const user = await seedUser(db, 'environment-image-sdk'),
      ws = await seedWorkspace(db, user, [{ userId: user, role: 'admin' }])
    const { buildEnvironmentSnapshot } = await import('../lib/project-resources/environment-snapshot-build')
    const { saveEnvironment } = await import('../lib/project-resources/store')
    const { environmentSnapshotScope } = await import('../lib/secrets/e2b-runtime')
    const key = 'v2/github.com/fixture/project'
    const { id: environmentId, revision } = await saveEnvironment(user, {
      workspaceId: ws.id,
      name: 'SDK build',
      repositories: [{ key }],
      configuration: {
        setup: { approved: true, command: 'prepare-dependencies', copyFiles: [] },
        variables: { BUILD_LABEL: 'sdk' },
      },
    })
    const { enqueueEnvironmentBuild, reserveEnvironmentBuild } = await import('../lib/project-resources/environment-snapshots')
    const seed = { workspaceId:ws.id,environmentId,revision,userId:user,templateId:'codex',templateKind:'codex' as const,workerSha:sha }
    const first = await Promise.all([reserveEnvironmentBuild(seed,'manual'),reserveEnvironmentBuild(seed,'save')])
    assert.equal(first[0].id,first[1].id)
    const scheduled: string[] = []
    await Promise.all(first.map(({ id }) => enqueueEnvironmentBuild(id, async (buildId) => {
      scheduled.push(buildId)
    })))
    assert.deepEqual(scheduled, [first[0].id])
    const audit = await db.query("SELECT detail FROM workspace_resource_events WHERE kind='environment.snapshot_build_requested' AND \"resourceId\"=$1", [environmentId])
    assert.equal(audit.rowCount,1)
    assert.equal(audit.rows[0].detail.funding,'mikka_platform')
    const build = async (id:string) => {
      await buildEnvironmentSnapshot(id, async (actor, repository) => {
        assert.equal(actor, user)
        assert.equal(repository, key)
        return { token: 'fixture-read-only', repository: { id: '42' } }
      })
      return (
        await db.query('SELECT state,"providerId","sandboxId","logTail" FROM environment_snapshots WHERE id=$1', [id])
      ).rows[0]
    }
    const ready = await build(first[0].id)
    assert.deepEqual(await reserveEnvironmentBuild(seed,'manual'), {id:first[0].id,enqueue:false})
    assert.equal(ready.state, 'ready', ready.logTail)
    assert.equal(services.e2b.sandboxes.get(ready.sandboxId).state, 'killed')
    const task = await Sandbox.create(ready.providerId, services.e2bOptions)
    const second = await Sandbox.create(ready.providerId, services.e2bOptions)
    assert.notEqual(task.sandboxId, second.sandboxId)
    assert.equal(await task.files.read('/fixture/dependency'), 'prepared')
    await task.files.write('/fixture/dependency', 'task-one')
    assert.equal(await second.files.read('/fixture/dependency'), 'prepared')
    await Promise.all([task.kill(), second.kill()])
    services.e2b.state.filesystemSnapshotsEnabled = false
    const retry = randomUUID()
    await db.query(`INSERT INTO environment_snapshots(id,"workspaceId","environmentId",revision,"requestedBy","providerScope","templateKind","templateId","workerSha",state)
       VALUES($1,$2,$3,$4,$5,$6,'codex','codex',$7,'building')`,[retry,ws.id,environmentId,revision,user,environmentSnapshotScope(),sha])
    const failed = await build(retry)
    assert.equal(failed.state, 'failed')
    assert.match(failed.logTail, /snapshot/)
    assert.equal(services.e2b.sandboxes.get(failed.sandboxId).state, 'killed')
    const creates = services.e2b.requests.filter(item => item.method === 'POST' && item.path.endsWith('/v2/sandboxes'))
    assert.equal(creates.length,4)
    assert.doesNotMatch(JSON.stringify(creates.map(item => item.body)), /mikka-local-e2b|E2B_API_KEY|E2B_TEAM_ID|sdk-team/)
    const captures = services.e2b.requests.filter((item) => item.path.endsWith('/snapshots') && item.method === 'POST')
    assert.deepEqual(
      captures.map((item) => item.body.memory),
      [false, false],
    )
    const setups = services.e2b.requests.filter((item) => item.body?.process?.args?.at(-1) === 'prepare-dependencies')
    assert.equal(setups.length, 2)
    assert.doesNotMatch(
      JSON.stringify(setups),
      /Authorization: Basic|GIT_CONFIG_VALUE_0|fixture-read-only|mikka-local-e2b/,
    )
  },
)
