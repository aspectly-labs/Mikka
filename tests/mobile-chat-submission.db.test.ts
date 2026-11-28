import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { MessageContent } from 'eve/channels'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

/** The body the iOS app sends and resends unchanged after an unconfirmed send. */
type Submission = { text: string; botId: string; submissionId: string; images?: { dataUrl: string }[] }
import { SubmissionConflictError } from '../lib/coordinator-submission'
import { normalizeUserImages } from '../lib/coordinator/user-attachments'

test('native Eve keeps the mobile submission receipt when a response is lost', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const ownerId = await seedUser(pool, 'mobile-outbox')
  const workspace = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
  const botId = await seedBot(pool, workspace.id, ownerId)
  const { acceptEveMessage } = await import('../lib/eve/submission')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => {
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [ownerId])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const scope = { ownerId, botId, workspaceId: workspace.id, surface: 'web' as const }
  const send = ({ text, images, submissionId }: Submission) => {
    const message: MessageContent = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(images ?? []).map(({ dataUrl }) => ({ type: 'file' as const, data: dataUrl, mediaType: 'image/jpeg' })),
    ]
    const request = new Request('http://127.0.0.1/eve/v1/session?botId=' + botId, {
      method: 'POST', headers: { 'x-mikka-submission-id': submissionId },
    })
    return acceptEveMessage(scope, message, { botId, expectedWorkspaceId: workspace.id }, request)
  }
  const text = 'accepted-but-response-lost-' + randomUUID()
  const submissionId = randomUUID()
  const images = [{ uri: 'file:///fixture.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }]
  const body: Submission = { text, botId, submissionId, images: images.map(({ dataUrl }) => ({ dataUrl })) }
  const accepted = await send(body)
  // The response was lost after the commit: the phone retries the same body, several times over.
  for (const receipt of await Promise.all(Array.from({ length: 5 }, () => send({ ...body })))) {
    assert.equal(receipt.eventId, accepted.eventId)
  }
  await assert.rejects(send({ ...body, text: 'changed body' }), SubmissionConflictError)
  const events = (await pool.query('SELECT id, "dedupeKey", payload FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2', [ownerId, botId])).rows
  assert.equal(events.length, 1)
  assert.equal(events[0].id, accepted.eventId)
  assert.match(events[0].dedupeKey, /^personal_submission:v1:/)
  assert.deepEqual(events[0].payload.images, normalizeUserImages([{ dataUrl: images[0].dataUrl }]))
})
