import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'
import test from 'node:test'
import { Pool } from 'pg'
import { CLIENT_VERSION_HEADER, HOSTED_API_HEADERS } from '@mikka/protocol/version'
import { DEVICE_SESSION_HEADER, DEVICE_SESSION_VERSION, MODEL_CREDENTIAL_HEADER, PORTABLE_TASK_WORKSPACE_HEADER, PROJECT_ENVIRONMENT_HEADER, REPO_ORIGIN_HEADER, RUN_CREDENTIALS_HEADER, runAssignmentSchema } from '@mikka/protocol/device'
import { DAEMON_VERSION } from '../packages/daemon/src/paths'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { assignTaskEnvironment, seedRunProjectResources } from './helpers/run-project-resources'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'
import { seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { startPortableComputeProviders } from './support/portable-compute-providers.mjs'

const databaseUrl = process.env.E2E_DATABASE_URL
if (databaseUrl) assert.ok(disposableDatabase(), 'Provider test requires loopback disposable PostgreSQL')
else if (process.env.REQUIRE_DB === '1') assert.fail('Provider test requires PostgreSQL 17')

const repositoryKey = 'v2/github.com/mikka-fixtures/provider-choice'
const remoteUrl = 'https://github.com/mikka-fixtures/provider-choice.git'
const creditsModel = 'openai/gpt-5.5'
type Provider = 'cloudflare' | 'e2b'
const sizes = { e2b: 'medium', cloudflare: 'standard-3' } as const
const variant = (provider?: Provider) => {
  process.env.MIKKA_FLAG_OVERRIDES = provider ? JSON.stringify({ 'mikka-task-provider': provider }) : '{}'
}

test('provider-selected task runs keep their pin and restore the same workspace in both directions', { skip: !databaseUrl, timeout: 240_000 }, async t => {
  const target = new URL(databaseUrl!)
  const admin = new Pool({ connectionString: target.href })
  const name = 'provider_choice_' + randomUUID().replaceAll('-', '') + '_e2e'
  await createTestDatabase(admin, name, 'template0')
  target.pathname = '/' + name
  const pool = new Pool({ connectionString: target.href, max: 12, connectionTimeoutMillis: 5_000 })
  const scratch = await mkdtemp(join(tmpdir(), 'mikka-provider-choice-'))
  const previousEnv = { ...process.env }
  let appPool: Pool | undefined
  let workspacePool: Pool | undefined
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
    await dropTestDatabase(admin, name, pool, appPool, workspacePool)
    await admin.end()
    await rm(scratch, { recursive: true, force: true })
  })
  await pool.query('SELECT 1')
  assert.equal(Math.floor(Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num) / 10_000), 17)
  const directory = new URL('../drizzle/', import.meta.url)
  for (const file of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
    await pool.query(await readFile(new URL(file, directory), 'utf8'))

  const source = join(scratch, 'authorized-repository')
  await mkdir(source)
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' })
  git('init', '--initial-branch=main')
  await writeFile(join(source, 'tracked.txt'), 'baseline\n')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Authorized source')
  const workerSha = 'a'.repeat(40)
  const templates = Object.fromEntries(['codex', 'claude', 'desktop'].map(kind => [kind,
    { templateId: kind + '-fixture', models: [], baseTemplate: kind, preinstalled: true }]))
  const templateReceipt = JSON.stringify({ version: 1, workerSha, templates,
    machineVariants: Object.entries(templates).map(([kind, template]) => ({
      kind, size: 'medium', templateId: template.templateId, cpuCount: 2, memoryMB: 8192,
    })) })
  type Guest = ReturnType<typeof import('./support/portable-compute-guest.mjs').portableComputeGuest>
  const registrationDirs = new WeakMap<Guest, string>()
  const startRegistration = (guest: Guest) => {
    // Keep the daemon's Unix socket below the platform path limit.
    const dataDir = join(scratch, 'reg-' + randomUUID().slice(0, 8))
    registrationDirs.set(guest, dataDir)
    return guest.daemon(['tests/support/portable-compute-register.mts'], {
      MIKKA_TEST_REGISTER_URL: applicationOrigin + '/mikka',
      MIKKA_TEST_DATA_DIR: dataDir,
      HOME: guest.local('/home/fixture'),
    })
  }
  const options = {
    root: scratch,
    e2bRegisteredMessage: 'mikka-worker-registered',
    workerSha,
    async registerE2B(guest: Guest, _runId: string, bytes: Uint8Array) {
      const worker = startRegistration(guest)
      const input = worker.stdin.getWriter()
      await input.write(bytes)
      await input.close()
      const [stdout, stderr, result] = await Promise.all([text(worker.stdout), text(worker.stderr), worker.wait()])
      if (process.env.MIKKA_PORTABLE_FIXTURE_DEBUG) console.error('E2B registration stdout', stdout, 'stderr', stderr)
      assert.equal(result.exitCode, 0, stderr)
      assert.ok(stdout.split('\n').includes('mikka-task-worker-registered'))
    },
    spawnCloudflare: startRegistration,
  }
  const services = await startPortableComputeProviders(t, options)
  Object.assign(process.env, {
    ...services.env, NODE_ENV: 'test', MIKKA_EDITION: 'cloud', MIKKA_BASE_PATH: '/mikka', CI: 'true', MIKKA_DATABASE_URL: target.href, DATABASE_URL: target.href,
    E2B_CODEX_TEMPLATE: templates.codex.templateId, E2B_CLAUDE_TEMPLATE: templates.claude.templateId,
    E2B_BYO_COMPUTER_TEMPLATE: templates.desktop.templateId, E2B_TEAM_ID: 'fixture-team', MIKKA_CLOUD_WORKER_SHA: workerSha,
    MIKKA_CLOUD_TEMPLATE_MODELS: templateReceipt, MIKKA_THREAD_SNAPSHOTS: '0', MIKKA_CLOUD_WORKER_URL: 'https://fixture-worker.example.invalid',
    WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    MIKKA_CLOUDFLARE_TASKS_DISABLED: '0', HTTPS_PROXY: '', https_proxy: '',
    MIKKA_LITELLM_URL: 'http://127.0.0.1:1', MIKKA_LITELLM_MASTER_KEY: 'fixture-gateway-key',
  })
  appPool = (await import('../lib/db')).pool
  workspacePool = (await import('../lib/workspace-db')).workspacePool
  const { serve } = await import('srvx/node')
  const { H3 } = await import('h3')
  let application: typeof import('../apps/api/src/index').default
  let gateway: InstanceType<typeof H3>
  const route = (request: Request) => /^\/mikka\/v1\/(?:live\/|devices\/[^/]+\/(?:socket|push|status)$)/.test(new URL(request.url).pathname)
    ? gateway.fetch(request) : application.fetch(request)
  const listener = serve({ manual: true, silent: true, gracefulShutdown: false, trustProxy: 'loopback', fetch: route }).node
  assert.ok(listener)
  const server = createServer(listener.handler)
  const require = createRequire(import.meta.url)
  const nitroRequire = createRequire(require.resolve('nitro/package.json'))
  const { default: adapter } = await import(pathToFileURL(nitroRequire.resolve('crossws/adapters/node')).href)
  const { NodeRequest } = await import(pathToFileURL(nitroRequire.resolve('srvx/node')).href)
  const websocket = adapter({ resolve: async (request: Request) => {
    const response = await route(request) as Response & { crossws?: unknown }
    return response.crossws ?? (request as unknown as Record<symbol, unknown>)[Symbol.for('crossws.hooks')] ?? {}
  } })
  server.on('upgrade', (request, socket, head) => {
    websocket.handleUpgrade(request, socket, head, new NodeRequest({ req: request, upgrade: { socket, head } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const applicationOrigin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  process.env.BETTER_AUTH_URL = applicationOrigin
  process.env.AUTH_TRUSTED_ORIGINS = applicationOrigin
  application = (await import('../apps/api/src/index')).default
  gateway = new H3().all('/**', (await import('../apps/api/routes/builtin-gateway')).createGatewayHandler())
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })

  const { queueCloudRun } = await import('../lib/computer/queue-run')
  const { startThreadMachine } = await import('../lib/run-leases')
  const { applyDeviceSessionReport } = await import('../lib/device-session')
  const { verifyGatewayToken } = await import('../lib/model-gateway/token')
  const { readEnvironmentSnapshot } = await import('../lib/project-resources/environment-snapshots')
  const { ensureThreadMachine, parkThreadMachine } = await import('../lib/cloud-computer/thread-machines')
  const sourceAt = (issueId: string) => pool.query('SELECT "archiveId","sourceRunId",size,sha256,"headSha" FROM task_workspace_archives WHERE "issueId"=$1', [issueId])
  const row = async (runId: string) => (await pool.query(`SELECT r."agentDefinition", r.status,m.* FROM agent_runs r
    JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1`, [runId])).rows[0]
  const ownerId = await seedUser(pool, 'provider-choice')
  const { id: workspaceId } = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
  const botId = await seedBot(pool, workspaceId, ownerId)
  const deviceId = randomUUID(), agentId = randomUUID(), deviceRepoId = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'Parent cloud fixture','cloud')`, [deviceId, ownerId])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,'Provider fixture','codex')`, [agentId, ownerId, deviceId])
  await pool.query(`INSERT INTO device_repos (id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,'main')`,
    [deviceRepoId, ownerId, deviceId, repositoryKey, remoteUrl])
  await pool.query(`INSERT INTO cloud_machines("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady")
    VALUES($1,$2,$3,'synthetic-parent',$4,'running',true)`, [workspaceId, ownerId, randomUUID(), deviceId])
  await pool.query(`INSERT INTO bot_desktops("botId","workspaceId","ownerId",display) VALUES($1,$2,$3,1)`, [botId, workspaceId, ownerId])
  await pool.query(`INSERT INTO bot_cloud_runtimes("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES($1,$2,$3,'codex',$4,$5)`,
    [botId, workspaceId, ownerId, agentId, deviceRepoId])
  await pool.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,500,'purchased','test',$3)`,
    [randomUUID(), workspaceId, randomUUID()])
  const actor = { userId: ownerId, workspaceId }
  const enqueue = async (issueId: string, requestId = randomUUID(), readOnly = false) => {
    const sourceEventId = requestId
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,"deliveredAt")
      VALUES($1,$2,$3,$4,'user_message',$5,'{"taskDestination":{"kind":"cloud","provider":"cloudflare"}}',now()) ON CONFLICT (id) DO NOTHING`,
    [sourceEventId, ownerId, botId, issueId, 'fixture:' + sourceEventId])
    return (await queueCloudRun(pool, actor, { botId, issueId, agentId, deviceRepoId, sourceEventId, idempotencyKey: requestId,
      title: 'Portable checkout fixture', body: '', model: creditsModel, credits: { model: creditsModel }, readOnly })).runId
  }
  const claim = async (machine: { sandboxId: string; deviceId: string; runId: string }, provider: Provider) => {
    const dataDir = registrationDirs.get(services.guest(provider, machine.sandboxId))
    assert.ok(dataDir)
    const { credential } = JSON.parse(await readFile(join(dataDir, 'device.json'), 'utf8'))
    assert.equal(typeof credential, 'string')
    // The registration subprocess exits after bootstrap. Open the session at
    // the same application boundary used by the gateway before claiming.
    assert.deepEqual(await applyDeviceSessionReport(machine.deviceId, {
      state: 'connected', at: new Date().toISOString(), socketId: randomUUID(),
    }), { applied: true })
    const url = applicationOrigin + '/mikka/v1/devices/' + machine.deviceId + '/runs/' + machine.runId + '/claim'
    const headers = {
      ...HOSTED_API_HEADERS,
      [CLIENT_VERSION_HEADER]: DAEMON_VERSION,
      [DEVICE_SESSION_HEADER]: String(DEVICE_SESSION_VERSION),
      [MODEL_CREDENTIAL_HEADER]: '1',
      [RUN_CREDENTIALS_HEADER]: '1',
      'x-forwarded-proto': 'https',
      [PROJECT_ENVIRONMENT_HEADER]: '1',
      [REPO_ORIGIN_HEADER]: '1',
      authorization: 'Bearer ' + credential,
    }
    const refused = await fetch(url, { method: 'POST', headers })
    assert.equal(refused.status, 409, 'archive-capable daemon required')
    assert.equal((await row(machine.runId)).status, 'queued')
    const accepted = await fetch(url, { method: 'POST', headers: { ...headers, [PORTABLE_TASK_WORKSPACE_HEADER]: '1' } })
    assert.equal(accepted.status, 200, accepted.ok ? undefined : await accepted.text())
    const assignment = runAssignmentSchema.parse(await accepted.json())
    assert.ok(assignment.modelCredential?.kind === 'provider')
    assert.equal(assignment.modelCredential.protocol, 'openai')
    assert.equal(assignment.modelCredential.baseUrl, applicationOrigin.replace('http:', 'https:') + '/mikka/api/model-gateway/openai/v1')
    const grant = await verifyGatewayToken(pool, assignment.modelCredential.key)
    assert.ok(grant)
    assert.deepEqual(grant.source, { kind: 'credits' })
    assert.equal(grant.runId, machine.runId)
    assert.equal(grant.workspaceId, workspaceId)
    assert.equal(grant.model, creditsModel)
    return assignment
  }
  const daemon = async (machine: { sandboxId: string; runId: string }, provider: Provider, operation: 'write'|'verify', receipt: unknown) => {
    const guest = services.guest(provider, machine.sandboxId)
    const remote = guest.daemon(['tests/support/portable-compute-daemon.mts', guest.local(guest.dataDirectory), source, machine.runId, operation])
    const writer = remote.stdin.getWriter()
    await writer.write(Buffer.from(JSON.stringify(receipt)))
    await writer.close()
    const [, error, result] = await Promise.all([text(remote.stdout), text(remote.stderr), remote.wait()])
    assert.equal(result.exitCode, 0, error)
  }
  await t.test('an unset flag keeps the legacy explicit Cloudflare placement', async () => {
    variant()
    const id = await enqueue(await seedIssue(pool, ownerId, workspaceId))
    assert.equal((await row(id)).snapshotId, 'cloudflare-task-v1')
  })
  await t.test('Factory handoff waits for review expiry before archiving and switching providers', async () => {
    const issueId = await seedIssue(pool, ownerId, workspaceId)
    const { environment } = await seedRunProjectResources(pool, { ownerId, workspaceId, issueId, repositoryKey, runtime: 'cloud', harness: 'codex' })
    assert.ok(environment)
    await assignTaskEnvironment(pool, ownerId, workspaceId, [issueId], environment.id)
    variant('e2b')
    const first = await enqueue(issueId)
    await ensureThreadMachine(pool, actor, first)
    const sourceMachine = await row(first)
    await daemon(sourceMachine, 'e2b', 'write', null)
    await pool.query(`UPDATE agent_runs SET status='succeeded',report='{"safePoint":{"session":"exited"}}',"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [first])
    assert.equal((await sourceAt(issueId)).rowCount, 0)

    variant('cloudflare')
    const next = await enqueue(issueId)
    await pool.query(`WITH task AS (
      INSERT INTO factory_tasks (id,"userId","workspaceId","botId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
      VALUES ($1,$2,$3,$4,$5,$6,'{}','execute','running',$7,'Factory handoff fixture') RETURNING id
    ) INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason)
      SELECT $7, id, 'execute', 1, 1, 'running', $8, 'Factory handoff fixture' FROM task`,
    [randomUUID(), ownerId, workspaceId, botId, issueId, randomUUID(), randomUUID(), next])
    const { handoffFactoryCloudStage } = await import('../lib/factory/cloud-stage-handoff')
    const review = randomUUID()
    const expiresAt = new Date(Date.now() + 60_000)
    await pool.query(`INSERT INTO coding_review_sessions (id,kind,name,"taskId","runId","ownerId","workspaceId","deviceId","repoId","deviceTokenId","bindingId","sandboxId","machineEpoch","machineOperationId","credentialKind","credentialId","expiresAt",provider)
      VALUES ($1,'terminal','',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'session',$13,$14,'e2b')`,
    [review, issueId, first, ownerId, workspaceId, sourceMachine.deviceId, sourceMachine.repoId, randomUUID(), 'a'.repeat(64),
      sourceMachine.sandboxId, sourceMachine.epoch, sourceMachine.operationId, randomUUID(), expiresAt])
    assert.deepEqual(await handoffFactoryCloudStage(pool, actor, first, next), { retryAt: expiresAt.getTime() })
    assert.equal((await row(next)).status, 'queued')
    assert.equal((await sourceAt(issueId)).rowCount, 0)
    await pool.query(`UPDATE coding_review_sessions SET "createdAt"=clock_timestamp()-interval '1 minute',"expiresAt"=clock_timestamp() WHERE id=$1`, [review])
    assert.equal(await handoffFactoryCloudStage(pool, actor, first, next), true)
    const pointer = (await sourceAt(issueId)).rows[0]
    assert.equal(pointer.sourceRunId, first)
    const restored = await row(next)
    assert.equal(restored.state, 'running')
    assert.deepEqual(restored.lifecycle.portableWorkspaceRestore, { size: Number(pointer.size), sha256: pointer.sha256, headSha: pointer.headSha })
  })
  for (const [from, to] of [['e2b', 'cloudflare'], ['cloudflare', 'e2b']] as const) {
    await t.test(from + ' to ' + to, async () => {
      const issueId = await seedIssue(pool, ownerId, workspaceId)
      const resources = await seedRunProjectResources(pool, { ownerId, workspaceId, issueId, repositoryKey, runtime: 'cloud', harness: 'codex' })
      assert.ok(resources.environment)
      const environmentId = resources.environment.id
      const preparation = (provider: Provider) => readEnvironmentSnapshot(ownerId, { workspaceId, environmentId, templateKind: 'codex', provider })
      await assignTaskEnvironment(pool, ownerId, workspaceId, [issueId], environmentId)
      variant(from)
      const requestId = randomUUID()
      const first = await enqueue(issueId, requestId)
      assert.deepEqual((await row(first)).agentDefinition.taskCompute, { provider: from, size: sizes[from] })
      variant(to)
      assert.equal(await enqueue(issueId, requestId), first)
      assert.deepEqual((await row(first)).agentDefinition.taskCompute, { provider: from, size: sizes[from] })
      await ensureThreadMachine(pool, actor, first)
      const original = await row(first)
      assert.equal(original.state, 'running')
      assert.equal((await preparation(from)).snapshot?.state, 'building')
      assert.deepEqual(original.agentDefinition.taskCompute, { provider: from, size: sizes[from] })
      assert.deepEqual(services.boots.at(-1), { provider: from, runId: first })
      await daemon(original, from, 'write', null)
      await pool.query(`UPDATE agent_runs SET status='succeeded',report='{"safePoint":{"session":"exited"}}',"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [first])
      await parkThreadMachine(pool, actor, first)
      const pointer = (await sourceAt(issueId)).rows[0]
      assert.equal(pointer.sourceRunId, first)
      assert.ok(Number(pointer.size) > 0)
      assert.match(pointer.sha256, /^[a-f0-9]{64}$/)
      assert.deepEqual((await row(first)).agentDefinition.taskCompute, { provider: from, size: sizes[from] })

      const denied = await enqueue(issueId)
      assert.equal((await row(denied)).agentDefinition.taskCompute.provider, to)
      const sourceCalls = from === 'e2b' ? services.e2b.e2b.requests.length : services.cloudflare.length
      if (to === 'cloudflare') services.fail.cloudflare = true
      else services.refuseE2B(429)
      assert.deepEqual(await startThreadMachine(actor, denied, false), { state: 'unavailable', reason: 'provider_unavailable', provider: to })
      assert.equal((await row(denied)).status, 'failed')
      assert.notEqual((await preparation(to)).snapshot?.state, 'building')
      services.fail.cloudflare = false
      services.refuseE2B(null)
      assert.equal(from === 'e2b' ? services.e2b.e2b.requests.length : services.cloudflare.length, sourceCalls)
      assert.deepEqual((await sourceAt(issueId)).rows[0], pointer)

      const readOnly = to === 'cloudflare'
      const next = await enqueue(issueId, randomUUID(), readOnly)
      assert.deepEqual((await row(next)).agentDefinition.taskCompute, { provider: to, size: sizes[to] })
      await ensureThreadMachine(pool, actor, next)
      const restored = await row(next)
      assert.equal(restored.state, 'running')
      const { snapshot } = await preparation(to)
      assert.ok(snapshot)
      assert.equal(snapshot.state, 'building')
      assert.equal((await pool.query('SELECT "buildRunId" FROM environment_snapshots WHERE id=$1', [snapshot.id])).rows[0].buildRunId, next)
      assert.deepEqual(services.boots.at(-1), { provider: to, runId: next })
      const assignment = await claim(restored, to)
      if (readOnly) {
        assert.equal(assignment.policy?.readOnly, true)
        assert.equal((await row(next)).lifecycle.portableWorkspaceCapture, undefined)
      }
      const { portableTaskWorkspace: receipt } = assignment
      assert.deepEqual(receipt, { size: Number(pointer.size), sha256: pointer.sha256, headSha: pointer.headSha })
      assert.deepEqual(restored.agentDefinition.projectExecution.environment, original.agentDefinition.projectExecution.environment)
      await daemon(restored, to, 'verify', receipt)
    })
  }
})
