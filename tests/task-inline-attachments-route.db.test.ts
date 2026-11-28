import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedIssue, seedPersonalWorkspace, seedUser } from './support/workspace-admin-db'

test('inline file HTTP contract enforces auth, sniffs actual bytes, and caps uploads per task', { skip: !disposableDatabase() }, async t => {
  const { pool } = await import('../lib/db')
  const owner = await seedUser(pool, 'attachment-route')
  const workspaceId = await seedPersonalWorkspace(pool, owner)
  const taskId = await seedIssue(pool, owner, workspaceId, { registered: true })
  t.after(async () => {
    await pool.query('delete from issues where id=$1', [taskId])
    await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from "user" where id=$1', [owner])
  })
  const session = { user: { id: owner, name: owner, email: owner + '@example.invalid' }, session: { id: 'session' }, tokenWorkspaceId: workspaceId }
  let signedIn = false
  const getSession = async () => signedIn ? session : null
  mock.module('@/lib/api-auth', { namedExports: { auth: { api: { getSession } }, getApiSession: getSession, apiWorkspaceAllowed: () => true } })
  const { GET, POST } = await import('../app/api/tasks/[taskId]/attachments/route')
  const url = 'http://localhost/api/tasks/' + taskId + '/attachments'
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const ctx = { params: Promise.resolve({ taskId }) }
  const upload = (id: string, blob: Blob) => {
    const form = new FormData()
    form.append('file', blob, 'preview.png')
    const request = new Request(url + '?placement=inline&id=' + id, { method: 'POST', headers: { origin: 'http://localhost' }, body: form })
    return runRequestScope(createRequestScope(request), () => POST(request, ctx))
  }
  const read = (id: string) => {
    const request = new Request(url + '?disposition=inline&id=' + id)
    return runRequestScope(createRequestScope(request), () => GET(request, ctx))
  }
  const png = new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], { type: 'text/plain' })
  const image = randomUUID()
  assert.equal((await upload(image, png)).status, 401)
  assert.equal((await read(image)).status, 401)
  signedIn = true
  const saved = await upload(image, png)
  assert.deepEqual(await saved.json(), { id: image, name: 'preview.png', size: 8, mediaType: 'image/png', placement: 'inline' })
  const preview = await read(image)
  assert.equal(preview.headers.get('content-type'), 'image/png')
  assert.match(preview.headers.get('content-disposition')!, /^inline;/)
  assert.deepEqual(await preview.arrayBuffer(), await png.arrayBuffer())
  const fake = randomUUID()
  assert.equal((await upload(fake, new Blob(['<svg/>'], { type: 'image/png' }))).status, 200)
  const download = await read(fake)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.match(download.headers.get('content-disposition')!, /^attachment;/)
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')

  await pool.query(`insert into task_attachments ("taskId", id, name, size, sha256, "inlineData", "userId", placement)
    select $1, gen_random_uuid(), 'f', 1, repeat('0',64), decode('00','hex'), $2, 'inline' from generate_series(1,97)`, [taskId, owner])
  assert.equal((await upload(randomUUID(), png)).status, 200)
  const over = await upload(randomUUID(), png)
  assert.equal(over.status, 409)
  assert.deepEqual(await over.json(), { error: 'tooMany' })
})
