import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER,
  OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER,
} from '@mikka/protocol/open-artifact'
import { signOpenArtifactBridgePayload } from '../lib/artifacts/open-artifact-bridge'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

const BRIDGE_SECRET = 'pg17-integration-test-secret-0123456789'
const HOST_ORIGIN = 'https://artifacts.mikka.example'

function signedJsonRequest(url: string, body: unknown, secret = BRIDGE_SECRET): Request {
  const rawBody = JSON.stringify(body)
  const { timestamp, signature } = signOpenArtifactBridgePayload(rawBody, secret)
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPEN_ARTIFACT_BRIDGE_TIMESTAMP_HEADER]: timestamp,
      [OPEN_ARTIFACT_BRIDGE_SIGNATURE_HEADER]: signature,
    },
    body: rawBody,
  })
}

test('Open Artifact signed bridge and wake routes round-trip against PostgreSQL 17 with monotonic versions and collaborator fencing', { skip: !dbUrl }, async t => {
  const prevSecret = process.env.OPEN_ARTIFACT_BRIDGE_SECRET
  const prevHost = process.env.OPEN_ARTIFACT_HOST_ORIGIN
  const prevTypes = process.env.OPEN_ARTIFACT_ENABLED_TYPES
  process.env.OPEN_ARTIFACT_BRIDGE_SECRET = BRIDGE_SECRET
  process.env.OPEN_ARTIFACT_HOST_ORIGIN = HOST_ORIGIN
  process.env.OPEN_ARTIFACT_ENABLED_TYPES = 'slides,docs'

  const [{ pool }, { workspacePool }, bridgeRoute, wakeRoute, store, settings] = await Promise.all([
    import('../lib/db'),
    import('../lib/workspace-db'),
    import('../app/api/artifacts/open-artifact/bridge/route'),
    import('../app/api/artifacts/open-artifact/wake/route'),
    import('../lib/artifacts/store'),
    import('../lib/settings/store'),
  ])
  pool.options.max = 2
  workspacePool.options.max = 2

  const users: string[] = []
  const workspaces: string[] = []
  t.after(async () => {
    if (prevSecret === undefined) delete process.env.OPEN_ARTIFACT_BRIDGE_SECRET
    else process.env.OPEN_ARTIFACT_BRIDGE_SECRET = prevSecret
    if (prevHost === undefined) delete process.env.OPEN_ARTIFACT_HOST_ORIGIN
    else process.env.OPEN_ARTIFACT_HOST_ORIGIN = prevHost
    if (prevTypes === undefined) delete process.env.OPEN_ARTIFACT_ENABLED_TYPES
    else process.env.OPEN_ARTIFACT_ENABLED_TYPES = prevTypes
    try {
      await pool.query('DELETE FROM coordinator_events WHERE "userId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM coordinator_bots WHERE "ownerId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM artifacts WHERE "userId"=ANY($1::text[])', [users])
      await pool.query('DELETE FROM workspace_setting_values WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
      await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    } finally {
      await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
      await Promise.all([pool.end(), workspacePool.end()])
    }
  })

  const owner = await seedUser(pool, 'oa-owner')
  const teammate = await seedUser(pool, 'oa-teammate')
  const outsider = await seedUser(pool, 'oa-outsider')
  users.push(owner, teammate, outsider)

  const workspace = await seedWorkspace(pool, owner, [
    { userId: owner, role: 'admin' },
    { userId: teammate, role: 'member' },
  ])
  const otherWorkspace = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  workspaces.push(workspace.id, otherWorkspace.id)

  const externalId = `oa_pg17_${Date.now()}`
  const bridgeUrl = 'https://mikka.example/mikka/api/artifacts/open-artifact/bridge'
  const wakeUrl = 'https://mikka.example/mikka/api/artifacts/open-artifact/wake'

  // 1. Disabled artifact type fails closed (403)
  const disabledRes = await bridgeRoute.POST(
    signedJsonRequest(bridgeUrl, {
      action: 'sync',
      event: 'created',
      subject: owner,
      workspaceId: workspace.id,
      externalId: `${externalId}_disabled`,
      title: 'Blocked Canvas',
      artifactType: 'whiteboard',
      version: 1,
    }),
  )
  assert.equal(disabledRes.status, 403)

  // 2. Signed create persists Open Artifact row in PG17
  const createRes = await bridgeRoute.POST(
    signedJsonRequest(bridgeUrl, {
      action: 'sync',
      event: 'created',
      subject: owner,
      workspaceId: workspace.id,
      externalId,
      title: 'Q4 Deck',
      artifactType: 'slides',
      version: 1,
    }),
  )
  assert.equal(createRes.status, 200)
  const created = await createRes.json()
  assert.equal(created.ok, true)
  assert.equal(created.workspaceId, workspace.id)
  assert.equal(created.version, 1)
  const artifactId: string = created.artifactId

  // 3. Store reads expose additive engine, externalId, artifactType, and embedUrl
  const detail = await store.readArtifact(owner, artifactId)
  assert.ok(detail)
  assert.equal(detail.engine, 'open_artifact')
  assert.equal(detail.externalId, externalId)
  assert.equal(detail.artifactType, 'slides')
  assert.equal(detail.embedUrl, `${HOST_ORIGIN}/a/${externalId}?embed=1`)

  // 4. Native submitArtifact refuses to overwrite an open_artifact row
  const nativeOverwrite = await store.submitArtifact(
    { userId: owner, workspaceId: workspace.id, runId: null, issueId: null, authorName: 'Tester' },
    { artifactId, title: 'Hijack', kind: 'html', content: '<p>overwrite</p>' },
  )
  assert.ok('error' in nativeOverwrite && nativeOverwrite.error === 'kind_mismatch')

  // 5. Authorize checks owner, outsider, and workspace-shared teammate
  const ownerAuthz = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, { action: 'authorize', subject: owner, externalId }),
    )
  ).json()
  assert.equal(ownerAuthz.role, 'owner')

  const outsiderAuthz = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, { action: 'authorize', subject: outsider, externalId }),
    )
  ).json()
  assert.equal(outsiderAuthz.role, null)

  const teammateBeforeShare = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, { action: 'authorize', subject: teammate, externalId }),
    )
  ).json()
  assert.equal(teammateBeforeShare.role, null)

  await store.createShare(owner, artifactId, 'workspace')
  const teammateAfterShare = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, { action: 'authorize', subject: teammate, externalId }),
    )
  ).json()
  assert.equal(teammateAfterShare.role, 'commenter')

  // 6. Guard enforces workspace sharing defaults
  await settings.writeSettings({ userId: owner, workspaceId: workspace.id }, 'workspace', {
    values: { artifactShareVisibility: 'workspace' },
  })
  const deniedLink = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, {
        action: 'guard',
        subject: owner,
        externalId,
        guardAction: 'share.create',
        detail: { visibility: 'link' },
      }),
    )
  ).json()
  assert.equal(deniedLink.allow, false)

  const allowedWs = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, {
        action: 'guard',
        subject: owner,
        externalId,
        guardAction: 'share.create',
        detail: { visibility: 'workspace' },
      }),
    )
  ).json()
  assert.equal(allowedWs.allow, true)

  // 7. Monotonic version sync: v3 followed by stale v2 never regresses latestVersion
  const v3Res = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, {
        action: 'sync',
        event: 'updated',
        subject: owner,
        externalId,
        title: 'Q4 Deck Final',
        version: 3,
      }),
    )
  ).json()
  assert.equal(v3Res.version, 3)

  const staleV2Res = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, {
        action: 'sync',
        event: 'updated',
        subject: owner,
        externalId,
        version: 2,
      }),
    )
  ).json()
  assert.equal(staleV2Res.version, 3)

  // 8. Signed wake persists owner_turn as user_message and collaborator as fenced run_report
  const ownerWake = await (
    await wakeRoute.POST(
      signedJsonRequest(wakeUrl, {
        externalId,
        reason: 'request',
        from: { kind: 'owner', subject: owner, name: 'Owner', role: 'owner' },
        text: 'Polish slide 2 headline',
      }),
    )
  ).json()
  assert.equal(ownerWake.ok, true)
  assert.equal(ownerWake.classification, 'owner_turn')

  const collabWake = await (
    await wakeRoute.POST(
      signedJsonRequest(wakeUrl, {
        externalId,
        reason: 'comment',
        from: { kind: 'collaborator', subject: teammate, name: 'Teammate', role: 'commenter' },
        text: 'Please review Q4 numbers',
      }),
    )
  ).json()
  assert.equal(collabWake.ok, true)
  assert.equal(collabWake.classification, 'fenced_notice')

  const { rows: events } = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
    'SELECT kind, payload FROM coordinator_events WHERE "userId"=$1 ORDER BY "createdAt" ASC',
    [owner],
  )
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'user_message')
  assert.equal(events[0].payload.classification, 'owner_turn')
  assert.equal(events[1].kind, 'run_report')
  assert.equal(events[1].payload.source, 'open_artifact_fenced_notice')

  // 9. Signed delete removes catalog row and subsequent authorize fails closed
  const deleteRes = await bridgeRoute.POST(
    signedJsonRequest(bridgeUrl, { action: 'sync', event: 'deleted', subject: owner, externalId }),
  )
  assert.equal(deleteRes.status, 200)
  const afterDelete = await (
    await bridgeRoute.POST(
      signedJsonRequest(bridgeUrl, { action: 'authorize', subject: owner, externalId }),
    )
  ).json()
  assert.equal(afterDelete.role, null)
})
