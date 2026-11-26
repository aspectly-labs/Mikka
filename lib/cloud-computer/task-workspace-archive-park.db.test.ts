import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'
import { Sandbox } from 'e2b'
import { Pool } from 'pg'
import { writeTaskArchive } from '../../packages/daemon/src/task-workspace-archive.mjs'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { startExternalServices } from '../../tests/fakes/external-services.mjs'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { seedAgent, seedIssue, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

const available = disposableDatabase()
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Park regression requires disposable PostgreSQL')

test('production park preserves the prior portable archive on failed upload with a single APP connection', { skip: !available, timeout: 120_000 }, async t => {
  const target = new URL(process.env.E2E_DATABASE_URL!)
  const admin = new Pool({ connectionString: target.href })
  const database = `archive_park_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  target.pathname = `/${database}`
  const app = new Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 2_000 })
  const globalDb = globalThis as { mikkaPool?: Pool }
  const previousPool = globalDb.mikkaPool
  globalDb.mikkaPool = app
  t.after(async () => {
    globalDb.mikkaPool = previousPool
    await app.end()
    try { await dropTestDatabase(admin, database) } finally { await admin.end() }
  })

  const directory = new URL('../../drizzle/', import.meta.url)
  for (const file of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql'))))
    await app.query(await readFile(new URL(file, directory), 'utf8'))

  const scratch = await mkdtemp(join(tmpdir(), 'mikka-archive-park-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const worktree = join(scratch, 'source')
  await mkdir(worktree)
  const git = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { stdio: 'pipe' })
  git('init')
  await writeFile(join(worktree, 'tracked.txt'), 'committed version\n')
  git('add', 'tracked.txt')
  git('-c', 'user.name=Archive Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Seed task fixture')
  const fixture = async (name: string) => {
    await writeFile(join(worktree, 'tracked.txt'), name + '\n')
    const path = join(scratch, name + '.tar.zst')
    const receipt = await writeTaskArchive(worktree, path)
    return { receipt, bytes: await readFile(path) }
  }
  const firstArchive = await fixture('previous')
  const nextArchive = await fixture('candidate')
  const secretValue = 'fixture-never-upload-' + randomUUID()
  const taintedArchive = await fixture(secretValue)
  let candidateArchive = nextArchive
  const captures: string[] = []
  const services = await startExternalServices({ e2b: { commands(command: string, { sandbox }: { sandbox: { files: Map<string, Buffer> } }) {
    if (command.startsWith('env -i ')) {
      const path = /\/tmp\/mikka-task-workspace-[\w-]+\.tar\.zst/.exec(command)?.[0]
      assert.ok(path)
      const source = captures.length ? candidateArchive : firstArchive
      sandbox.files.set(path, source.bytes)
      captures.push(path)
      return { stdout: JSON.stringify(source.receipt), exitCode: 0 }
    }
    if (command.startsWith('install -d -m 700 ')) {
      if (!command.includes('test ! -L')) return { exitCode: 0 }
      const source = /\/tmp\/mikka-task-workspace-[\w-]+\.tar\.zst/.exec(command)?.[0]
      const sealed = /\/run\/mikka-task-archives\/[\w-]+\.tar\.zst/.exec(command)?.[0]
      assert.ok(source && sealed)
      assert.ok(sandbox.files.has(source))
      sandbox.files.set(sealed, sandbox.files.get(source)!)
      sandbox.files.delete(source)
      return { exitCode: 0 }
    }
    if (command.startsWith('rm -f -- ')) {
      for (const path of command.slice('rm -f -- '.length).split(' ')) sandbox.files.delete(path)
      return { exitCode: 0 }
    }
    if (command.startsWith('umask 077; cat -- ')) {
      const scratch = /cat -- '([^']+)'\/\*\.part/.exec(command)?.[1]
      const destination = /mv -- '[^']+' '([^']+)'/.exec(command)?.[1]
      assert.ok(scratch && destination)
      const parts = [...sandbox.files.entries()].filter(([key]) => key.startsWith(scratch + '/') && key.endsWith('.part'))
      parts.sort(([a], [b]) => a.localeCompare(b))
      assert.ok(parts.length > 0)
      sandbox.files.set(destination, Buffer.concat(parts.map(([, value]) => value)))
      return { exitCode: 0 }
    }
    if (command.startsWith('rm -rf -- ')) {
      const prefix = /^rm -rf -- '([^']+)'$/.exec(command)?.[1]
      assert.ok(prefix)
      for (const path of sandbox.files.keys()) if (path.startsWith(prefix + '/')) sandbox.files.delete(path)
      return { exitCode: 0 }
    }
    assert.fail('Unexpected sandbox command in park fixture')
  } } })
  t.after(() => services.close())

  const objects = new Map<string, Buffer>()
  let refuseUpload = false, freeSlotReads = 0
  const bucket = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url) {
      const body = objects.get(request.url)
      if (body) response.writeHead(200, { 'content-length': body.length }).end(body)
      else response.writeHead(404).end()
      return
    }
    if (request.method !== 'PUT' || !request.url) { response.writeHead(405).end(); return }
    try {
      // This blocks or times out if production park retained its only APP slot.
      await app.query('select 1')
      freeSlotReads++
      const blocks: Buffer[] = []
      for await (const block of request) blocks.push(Buffer.from(block))
      if (refuseUpload) { response.writeHead(403).end(); return }
      assert.equal(request.headers['if-none-match'], '*')
      objects.set(request.url, Buffer.concat(blocks))
      response.writeHead(200).end()
    } catch { response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => bucket.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    bucket.closeAllConnections()
    await new Promise<void>(resolve => bucket.close(() => resolve()))
  })
  const env = {
    NODE_ENV: 'test', VERCEL_ENV: '', MIKKA_DATABASE_URL: target.href, DATABASE_URL: target.href,
    E2B_API_KEY: services.e2bOptions.apiKey, E2B_API_URL: services.e2bOptions.apiUrl,
    E2B_SANDBOX_URL: services.e2bOptions.sandboxUrl, E2B_HTTP_VERSION: '1.1',
    HTTPS_PROXY: '', https_proxy: '', MIKKA_THREAD_SNAPSHOTS: '0',
    WORKSPACE_SECRETS_KEY: 'a'.repeat(64),
    S3_ENDPOINT: `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`, S3_BUCKET: 'fixture',
    S3_ACCESS_KEY_ID: 'fixture-access', S3_SECRET_ACCESS_KEY: 'fixture-secret',
  }
  for (const [key, value] of Object.entries(env)) {
    const prior = process.env[key]
    process.env[key] = value
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior })
  }

  const { pool } = await import('../db')
  const { bindE2BResource } = await import('../secrets/e2b-resource')
  const { environmentSnapshotScope } = await import('../secrets/e2b-runtime')
  const { parkThreadMachine } = await import('./thread-machines')
  const owner = await seedUser(app, 'archive-park')
  const workspaceId = (await seedWorkspace(app, owner, [{ userId: owner, role: 'admin' }])).id
  const issueId = await seedIssue(app, owner, workspaceId)
  const agentId = await seedAgent(app, owner)
  const actor = { userId: owner, workspaceId } as Parameters<typeof parkThreadMachine>[1]
  const machine = async (createdAt: string) => {
    const sandbox = await Sandbox.create('codex', services.e2bOptions)
    const runId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID()
    await app.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'Archive park fixture','cloud')`, [deviceId, owner])
    await app.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl")
      VALUES ($1,$2,$3,'v2/github.com/acme/task','https://github.com/acme/task.git')`, [repoId, deviceId, owner])
    await app.query(`INSERT INTO agent_runs (id,"userId","agentId","issueId","deviceId","deviceRepoId",status,report,"startedAt","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6,'succeeded','{"safePoint":{"session":"exited"}}',$7,$7)`, [runId, owner, agentId, issueId, deviceId, repoId, createdAt])
    await app.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","issueId","deviceId","repoId","sandboxId","operationId","snapshotId",state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'codex','running')`, [runId, workspaceId, owner, issueId, deviceId, repoId, sandbox.sandboxId, randomUUID()])
    await bindE2BResource(owner, 'sandbox', sandbox.sandboxId, environmentSnapshotScope())
    return { runId, sandboxId: sandbox.sandboxId }
  }
  const archive = async () => (await app.query('SELECT "archiveId","sourceRunId" AS "runId",sha256 FROM task_workspace_archives WHERE "issueId"=$1', [issueId])).rows[0]
  const state = async (runId: string) => (await app.query('SELECT state,lifecycle FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]

  const first = await machine('2026-01-01T00:00:00Z')
  await parkThreadMachine(pool, actor, first.runId)
  assert.equal((await state(first.runId)).state, 'paused')
  const prior = await archive()
  assert.equal(prior.runId, first.runId)
  assert.deepEqual([...objects.values()], [firstArchive.bytes])

  const next = await machine('2026-01-01T00:01:00Z')
  refuseUpload = true
  await assert.rejects(parkThreadMachine(pool, actor, next.runId), /403/)
  assert.deepEqual(await archive(), prior)
  const failed = await state(next.runId)
  assert.equal(failed.state, 'running')
  assert.equal(failed.lifecycle.phase, 'pause_failed')
  assert.equal(failed.lifecycle.portableWorkspaceCaptureId, undefined)
  assert.equal((await Sandbox.getInfo(next.sandboxId, services.e2bOptions)).state, 'running')

  refuseUpload = false
  await parkThreadMachine(pool, actor, next.runId)
  const current = await archive()
  assert.equal(current.runId, next.runId)
  assert.notEqual(current.archiveId, prior.archiveId)
  assert.equal(current.sha256, nextArchive.receipt.sha256)
  assert.equal((await state(next.runId)).state, 'paused')
  assert.deepEqual([...objects.values()], [firstArchive.bytes, nextArchive.bytes])
  assert.equal(captures.length, 3)
  assert.equal(freeSlotReads, 3)

  // Lose the old provider cache and restore the bytes through the real R2
  // reader and daemon into a new Git checkout, without the previous VM.
  await Sandbox.kill(next.sandboxId, services.e2bOptions)
  const { loadTaskWorkspaceArchive } = await import('./task-workspace-archive-store')
  const { WorktreeManager } = await import('../../packages/daemon/src/worktrees')
  const saved = await loadTaskWorkspaceArchive(app, { ownerId: owner, workspaceId, issueId, repositoryKey: 'v2/github.com/acme/task' })
  assert.ok(saved)
  const { stageE2BTaskWorkspace } = await import('./e2b-task-workspace-archive')
  const newSandbox = await Sandbox.create('codex', services.e2bOptions)
  const fresh = join(scratch, 'new-machine'), cache = join(fresh, 'repository')
  await mkdir(fresh)
  execFileSync('git', ['clone', '--no-hardlinks', worktree, cache], { stdio: 'pipe' })
  const manager = new WorktreeManager(join(fresh, 'worktrees'), false, true)
  const freshRun = randomUUID(), base = await manager.portableWorktreeBase(cache, 'HEAD', saved.manifest.headSha)
  const checkout = await manager.create(freshRun, cache, base)
  const stagingReceipt = await stageE2BTaskWorkspace(newSandbox, freshRun, saved, AbortSignal.timeout(20_000))
  const staged = await newSandbox.files.read('/home/user/.mikka/worker/portable-workspaces/' + freshRun + '.tar.zst', { format: 'stream' })
  const staging = join(fresh, 'portable-workspaces')
  await mkdir(staging)
  await pipeline(staged, createWriteStream(join(staging, freshRun + '.tar.zst')))
  await manager.restorePortableWorkspace(freshRun, stagingReceipt, base)
  assert.equal(await readFile(join(checkout, 'tracked.txt'), 'utf8'), 'candidate\n')
  // A resolved workspace credential copied into an ordinary file must be
  // rejected on the sealed validation pass, before any R2 request writes it.
  const { sealSecret, secretAad } = await import('../secrets/crypto')
  const encrypted = sealSecret(secretValue, secretAad({ workspaceId, kind: 'secret', scopeType: 'workspace', scopeRef: '', name: 'ARCHIVE_FIXTURE' }))
  await app.query(`INSERT INTO workspace_secrets (id,"workspaceId",name,kind,"scopeType",ciphertext,iv,"keyVersion","createdBy","updatedBy")
    VALUES ($1,$2,'ARCHIVE_FIXTURE','secret','workspace',$3,$4,$5,$6,$6)`,
  [randomUUID(), workspaceId, encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, owner])
  candidateArchive = taintedArchive
  const tainted = await machine('2026-01-01T00:02:00Z')
  await assert.rejects(parkThreadMachine(pool, actor, tainted.runId), /contains a secret/)
  assert.equal(freeSlotReads, 3, 'the rejected staged archive never reached storage')
  assert.equal(objects.size, 2)
  assert.deepEqual(await archive(), current)
  assert.equal((await app.query('SELECT 1 FROM e2b_compute_leases')).rowCount, 0,
    'capturing a running workspace never purchases or extends compute')
})
