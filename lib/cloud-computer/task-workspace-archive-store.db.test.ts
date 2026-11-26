import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'
import { promisify } from 'node:util'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { seedAgent, seedIssue, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { loadTaskWorkspaceArchive, prepareTaskWorkspaceArchive, pruneTaskWorkspaceArchives, publishTaskWorkspaceArchive, taskWorkspaceArchiveKey } from './task-workspace-archive-store'

const available = disposableDatabase()
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Task archive tests require disposable PostgreSQL')

const headSha = 'a'.repeat(40)

const snapshot = (content: string) => {
  const bytes = Uint8Array.from(Buffer.from(content))
  return { bytes, manifest: { id: randomUUID(), headSha, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } }
}

test('real PostgreSQL fences task workspace archives and retains the last verified object', { skip: !available, timeout: 180_000 }, async t => {
  const target = new URL(process.env.E2E_DATABASE_URL!)
  const admin = new Pool({ connectionString: target.href })
  t.after(() => admin.end())
  const database = `task_archive_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 2_000 })
  // Explicit cleanup order: the admin pool is needed until the DB is dropped.
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) {
      await pool.query(await readFile(new URL(file, directory), 'utf8'))
    }

    const bucket = new Map<string, Uint8Array>()
    const scratch = await mkdtemp(join(tmpdir(), 'mikka-task-archive-test-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    let largeKey: string | undefined
    const largeObject = join(scratch, 'bucket-object')
    let refusePut = false
    let refusePart = false, aborted = 0
    let multipart: { id: string; files: string[] } | undefined
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1')
      const path = url.pathname
      if (path === largeKey && url.searchParams.has('uploads')) {
        assert.equal(request.method, 'POST')
        multipart = { id: randomUUID() + '+=/', files: [] }
        response.writeHead(200).end(`<InitiateMultipartUploadResult><UploadId>${multipart.id}</UploadId></InitiateMultipartUploadResult>`)
        return
      }
      if (path === largeKey && url.searchParams.has('uploadId')) {
        const upload = multipart!
        assert.equal(url.searchParams.get('uploadId'), upload.id)
        if (request.method === 'PUT') {
          const number = upload.files.length + 1
          assert.equal(url.searchParams.get('partNumber'), String(number))
          const file = join(scratch, `${upload.id.slice(0, 36)}-part-${number}`)
          await pipeline(request, createWriteStream(file))
          assert.equal((await stat(file)).size, Number(request.headers['content-length']))
          upload.files.push(file)
          if (refusePart && number === 2) { response.writeHead(403).end(); return }
          response.writeHead(200, { etag: `"part-${number}"` }).end()
          return
        }
        if (request.method === 'POST') {
          assert.equal(request.headers['if-none-match'], '*')
          assert.equal(upload.files.length, 3)
          let xml = ''
          for await (const chunk of request) xml += String(chunk)
          assert.equal(xml, `<CompleteMultipartUpload>${upload.files.map((_, index) =>
            `<Part><PartNumber>${index + 1}</PartNumber><ETag>"part-${index + 1}"</ETag></Part>`).join('')}</CompleteMultipartUpload>`)
          const output = await open(largeObject, 'wx')
          try {
            for (const file of upload.files) {
              for await (const chunk of createReadStream(file)) await output.writeFile(chunk)
            }
          } finally { await output.close() }
          response.writeHead(200).end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
        } else {
          assert.equal(request.method, 'DELETE')
          aborted++
          response.writeHead(204).end()
        }
        multipart = undefined
        await Promise.all(upload.files.map(file => rm(file)))
        return
      }
      if (request.method === 'PUT') {
        assert.equal(request.headers['if-none-match'], '*')
        const blocks = []
        for await (const block of request) blocks.push(Buffer.from(block))
        if (refusePut) { response.writeHead(403).end(); return }
        if (bucket.has(path)) { response.writeHead(412).end(); return }
        bucket.set(path, Buffer.concat(blocks))
        response.writeHead(200).end()
      } else if (request.method === 'DELETE') {
        response.writeHead(bucket.delete(path) ? 204 : 404).end()
      } else if (request.method === 'GET') {
        if (path === largeKey) {
          await pipeline(createReadStream(largeObject), response)
          return
        }
        const body = bucket.get(path)
        response.writeHead(body ? 200 : 404).end(body)
      } else response.writeHead(405).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const values = { S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, S3_BUCKET: 'fixture', S3_ACCESS_KEY_ID: 'fixture-access', S3_SECRET_ACCESS_KEY: 'fixture-secret' }
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    t.after(async () => {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    })

    const ownerId = await seedUser(pool, 'archive-owner')
    const workspaceId = (await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])).id
    const issueId = await seedIssue(pool, ownerId, workspaceId)
    const agentId = await seedAgent(pool, ownerId)
    const deviceId = randomUUID(), repoId = randomUUID()
    const repositoryKey = 'v2/github.com/acme/task'
    const scope = { ownerId, workspaceId, issueId, repositoryKey }
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'Archive fixture','cloud')`, [deviceId, ownerId])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl")
      VALUES ($1,$2,$3,$4,'https://github.com/acme/task.git')`, [repoId, deviceId, ownerId, repositoryKey])
    const machine = async (createdAt: string) => {
      const runId = randomUUID(), epoch = 1, operationId = randomUUID(), sandboxId = `archive-${runId}`
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","issueId","deviceId","deviceRepoId",status,"createdAt")
        VALUES ($1,$2,$3,$4,$5,$6,'succeeded',$7)`, [runId, ownerId, agentId, issueId, deviceId, repoId, createdAt])
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","issueId","deviceId","repoId","sandboxId","operationId","snapshotId",state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'fixture','running')`, [runId, workspaceId, ownerId, issueId, deviceId, repoId, sandboxId, operationId])
      return { runId, epoch, operationId, sandboxId }
    }
    const early = await machine('2026-01-01T00:00:00.000001Z')
    const later = await machine('2026-01-01T00:00:00.000002Z')
    const oldSnapshot = snapshot('known old tree'), nextSnapshot = snapshot('next verified tree')
    const save = async (fence: typeof early, archive: ReturnType<typeof snapshot>, opts: { rollback?: boolean; scope?: typeof scope } = {}) => {
      const prepared = await prepareTaskWorkspaceArchive(pool, opts.scope ?? scope, archive.manifest, archive.bytes)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const saved = await publishTaskWorkspaceArchive(client, opts.scope ?? scope, fence, prepared)
        await client.query(opts.rollback ? 'ROLLBACK' : 'COMMIT')
        return saved
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    const loadSmall = async () => {
      const result = await loadTaskWorkspaceArchive(pool, scope)
      return result && { manifest: result.manifest, bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()) }
    }
    const path = (archive: ReturnType<typeof snapshot>) => `/fixture/${taskWorkspaceArchiveKey(scope, archive.manifest.id)}`
    const expire = async () => pool.query(`UPDATE task_workspace_archive_objects SET "expiresAt"=now()-interval '1 second'`)

    await t.test('scoped keys, exact machine fence, and deterministic retry', async () => {
      assert.match(taskWorkspaceArchiveKey(scope, oldSnapshot.manifest.id), /^task-workspaces\/v1\/[0-9a-f]{64}\/[0-9a-f-]+\.tar\.zst$/)
      assert.equal(await loadTaskWorkspaceArchive(pool, scope), null)
      assert.equal(await save({ ...early, operationId: randomUUID() }, oldSnapshot), false)
      assert.equal(await save({ ...early, sandboxId: 'different' }, oldSnapshot), false)
      assert.equal(await save({ ...early, epoch: 2 }, oldSnapshot), false)
      assert.equal(await save(early, oldSnapshot, { scope: { ...scope, repositoryKey: 'v2/github.com/acme/wrong' } }), false)
      assert.equal(await save(early, oldSnapshot), true)
      assert.equal(await save(early, snapshot('known old tree')), true)
      assert.equal(await save(early, { ...oldSnapshot, manifest: { ...oldSnapshot.manifest, id: randomUUID(), headSha: 'b'.repeat(40) } }), false)
      const published = await loadTaskWorkspaceArchive(pool, scope)
      assert.deepEqual(published?.source, { runId: early.runId, epoch: early.epoch, operationId: early.operationId })
      await published?.stream.cancel()
      assert.equal(await save(early, snapshot('different payload')), false)
      assert.deepEqual(await loadSmall(), oldSnapshot)
      for (const wrongScope of [
        { ...scope, ownerId: 'other-owner' }, { ...scope, workspaceId: randomUUID() },
        { ...scope, issueId: randomUUID() }, { ...scope, repositoryKey: 'v2/github.com/acme/wrong' },
      ]) assert.equal(await loadTaskWorkspaceArchive(pool, wrongScope), null)
      await assert.rejects(save(later, { ...nextSnapshot, manifest: { ...nextSnapshot.manifest, sha256: 'a'.repeat(64) } }), /integrity mismatch/)
    })

    await t.test('a provider failure and an owner transaction rollback preserve the old pointer', async () => {
      refusePut = true
      try { await assert.rejects(save(later, nextSnapshot), /put failed: 403/) } finally { refusePut = false }
      assert.deepEqual(await loadSmall(), oldSnapshot)
      assert.equal(await save(later, nextSnapshot, { rollback: true }), true)
      assert.equal(bucket.has(path(nextSnapshot)), true)
      assert.deepEqual(await loadSmall(), oldSnapshot)
      assert.equal(await save(later, nextSnapshot), true, 'conditional retry reuses the exact object')
      assert.deepEqual(await loadSmall(), nextSnapshot)
      assert.equal(await save(early, snapshot('stale run remains live')), false)
      await expire()
      while (await pruneTaskWorkspaceArchives(pool)) { /* Also reclaim unpublished stale receipts. */ }
      assert.equal(bucket.has(path(oldSnapshot)), false)
      assert.equal(await pruneTaskWorkspaceArchives(pool), false, 'current archive remains reachable past its staging expiry')
    })

    await t.test('pruning a rolled-back upload and detecting a conflicting object at a known ID', async () => {
      const nextFence = { ...later, epoch: 2 }
      await pool.query('UPDATE thread_machines SET epoch=$2 WHERE "runId"=$1', [later.runId, nextFence.epoch])
      const rolledBack = snapshot('rolled back after PUT')
      assert.equal(await save(nextFence, rolledBack, { rollback: true }), true)
      await expire()
      assert.equal(await pruneTaskWorkspaceArchives(pool), true)
      assert.equal(bucket.has(path(rolledBack)), false)
      await assert.rejects(save(nextFence, rolledBack), /retired ID/)
      const collision = snapshot('expected immutable bytes')
      bucket.set(path(collision), Buffer.from('conflicting payload'))
      await assert.rejects(save(nextFence, collision), /mismatch/)
      assert.deepEqual(await loadSmall(), nextSnapshot)
      bucket.set(path(nextSnapshot), Buffer.alloc(nextSnapshot.manifest.size + 1))
      await assert.rejects(loadSmall(), /size mismatch/)
      bucket.set(path(nextSnapshot), nextSnapshot.bytes)
      assert.deepEqual(await loadSmall(), nextSnapshot)
      await pool.query('UPDATE task_workspace_archives SET "headSha"=$1 WHERE "archiveId"=$2', ['b'.repeat(40), nextSnapshot.manifest.id])
      try { await assert.rejects(loadSmall(), /metadata mismatch/) }
      finally { await pool.query('UPDATE task_workspace_archives SET "headSha"=$1 WHERE "archiveId"=$2', [headSha, nextSnapshot.manifest.id]) }
    })

    await t.test('archives and restores an incompressible file larger than 32 MiB by streaming', async () => {
      const exec = promisify(execFile)
      const original = join(scratch, 'file.bin')
      const output = await open(original, 'wx')
      const originalHash = createHash('sha256')
      try {
        for (let index = 0; index < 34 * 4; index++) {
          const chunk = randomBytes(256 * 1024)
          originalHash.update(chunk)
          await output.writeFile(chunk)
        }
      } finally { await output.close() }
      const compressed = join(scratch, 'upload.tar.zst')
      await exec('tar', ['-cf', join(scratch, 'upload.tar'), '-C', scratch, 'file.bin'])
      await pipeline(createReadStream(join(scratch, 'upload.tar')), createZstdCompress(), createWriteStream(compressed))
      const hash = async (file: string) => {
        const digest = createHash('sha256')
        for await (const chunk of createReadStream(file)) digest.update(chunk)
        return digest.digest('hex')
      }
      const manifest = { id: randomUUID(), headSha, size: (await stat(compressed)).size, sha256: await hash(compressed) }
      assert.ok(manifest.size > 32 * 1024 * 1024)
      largeKey = `/fixture/${taskWorkspaceArchiveKey(scope, manifest.id)}`
      const fence = { ...later, epoch: 3 }
      await pool.query('UPDATE thread_machines SET epoch=$2 WHERE "runId"=$1', [fence.runId, fence.epoch])
      const upload = async () => {
        const input = Readable.toWeb(createReadStream(compressed)) as ReadableStream<Uint8Array>
        const prepared = await prepareTaskWorkspaceArchive(pool, scope, manifest, input)
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          assert.equal(await publishTaskWorkspaceArchive(client, scope, fence, prepared), true)
          await client.query('COMMIT')
        } catch (error) { await client.query('ROLLBACK'); throw error }
        finally { client.release() }
      }
      const prior = await loadTaskWorkspaceArchive(pool, scope)
      await prior?.stream.cancel()
      refusePart = true
      await assert.rejects(upload(), /multipart part 2 failed: 403/)
      assert.equal(aborted, 1)
      const stillPublished = await loadTaskWorkspaceArchive(pool, scope)
      assert.deepEqual(stillPublished?.manifest, prior?.manifest)
      await stillPublished?.stream.cancel()
      refusePart = false
      await upload()
      const restored = await loadTaskWorkspaceArchive(pool, scope)
      assert.deepEqual(restored?.manifest, manifest)
      const archivePath = join(scratch, 'restored.tar.zst')
      const restoredFile = await open(archivePath, 'wx')
      try { await restored!.stream.pipeTo(new WritableStream({ async write(chunk) { await restoredFile.writeFile(chunk) } })) }
      finally { await restoredFile.close() }
      await pipeline(createReadStream(archivePath), createZstdDecompress(), createWriteStream(join(scratch, 'restored.tar')))
      const restoreDirectory = join(scratch, 'restored')
      await mkdir(restoreDirectory)
      await exec('tar', ['-xf', join(scratch, 'restored.tar'), '-C', restoreDirectory])
      assert.equal(await hash(join(restoreDirectory, 'file.bin')), originalHash.digest('hex'))
    })
  } finally {
    await dropTestDatabase(admin, database, pool)
  }
})
