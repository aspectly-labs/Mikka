import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Task attachments storage test requires a disposable loopback *_e2e database')

// A configured but unreachable object store must surface TaskFileError('storage')
// (mapped to 503 by the route), never a bare TypeError leaking out as a 500.
test('dead object store: saveTaskFile and readTaskFile raise TaskFileError storage, not TypeError', { skip: !enabled }, async () => {
  const prior = {
    S3_ENDPOINT: process.env.S3_ENDPOINT, S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_REGION: process.env.S3_REGION, S3_PUBLIC_DOMAIN: process.env.S3_PUBLIC_DOMAIN,
    S3_ENABLE_PATH_STYLE: process.env.S3_ENABLE_PATH_STYLE, ASSET_S3_ACCESS_KEY_ID: process.env.ASSET_S3_ACCESS_KEY_ID,
  }
  process.env.S3_ENDPOINT = 'http://127.0.0.1:1' // closed port — no MinIO
  process.env.S3_BUCKET = 'orvilo'
  process.env.S3_ACCESS_KEY_ID = 'x'
  process.env.S3_SECRET_ACCESS_KEY = 'y'
  process.env.S3_REGION = 'us'
  process.env.S3_PUBLIC_DOMAIN = 'http://127.0.0.1:1/orvilo'
  process.env.S3_ENABLE_PATH_STYLE = '1'
  process.env.ASSET_S3_ACCESS_KEY_ID = 'x'
  try {
    const { pool } = await import('../lib/db')
    const store = await import('../lib/task-attachments/store')
    const owner = `taskfile-storage-${randomUUID()}`
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [owner, `${owner}@example.invalid`])
    const workspaceId = await seedFixtureWorkspace(pool, owner, 'team')
    const taskId = randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,revision) VALUES($1,$2,$3,$4,$5,'todo','normal',1)`,
      [taskId, owner, workspaceId, 'Attachment target', { type: 'doc', content: [] }])
    const actor = { user: { id: owner }, workspaceId, taskId }
    const file = { id: randomUUID(), name: 'note.txt', size: 4 }
    await assert.rejects(
      () => store.saveTaskFile(actor, file, new Uint8Array([1, 2, 3, 4])),
      (error: unknown) => error instanceof store.TaskFileError && error.code === 'storage' && error.cause !== undefined,
      'unreachable object store must raise TaskFileError storage with the original cause',
    )
    // The orphan cleanup row for the attempted key was pre-registered; the
    // attachments row itself must not exist after the failed transaction.
    const { rows } = await pool.query('SELECT id FROM task_attachments WHERE "taskId"=$1', [taskId])
    assert.equal(rows.length, 0)
    // Downloads fail the same controlled way when the object store is down.
    const stored = randomUUID()
    await pool.query(`INSERT INTO task_attachments("taskId",id,name,size,sha256,"storageKey","userId") VALUES($1,$2,'note.txt',4,$3,$4,$5)`,
      [taskId, stored, 'a'.repeat(64), `task-files/${taskId}/dead-key`, owner])
    await assert.rejects(
      () => store.readTaskFile(actor, stored, new AbortController().signal),
      (error: unknown) => error instanceof store.TaskFileError && error.code === 'storage' && error.cause !== undefined,
      'unreachable object store must raise TaskFileError storage on download too',
    )
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
