import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../tests/support/workspace-admin-db'

// Real hashed cloud credential and device-route authentication for the retired endpoint.
test('the retired subscription lease route refuses even an authorized device with an active run', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const owner = await seedUser(pool, 'cloud-lease-owner')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const device = randomUUID(), otherDevice = randomUUID(), agent = randomUUID(), runId = randomUUID(), otherRun = randomUUID(), tokenId = randomUUID()
  const { newDeviceToken, hashDeviceToken, authenticateDevice } = await import('./device-link')
  const credential = newDeviceToken()
  await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,harnesses) VALUES($1,$2,'Lease fixture','cloud',true,'[{"harness":"claude_code","installed":true,"subscriptionBroker":true}]'),($3,$2,'Other fixture','cloud',true,'[]')`, [device, owner, otherDevice])
  await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'claude_code','Lease fixture',$3)`, [agent, owner, device])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","workspaceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$7,'running',now()+interval '1 hour'),($5,$2,$3,$6,$7,'running',now()+interval '1 hour')`, [runId, owner, agent, device, otherRun, otherDevice, workspace.id])
  await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId") VALUES($1,$2,$3,'synthetic-template',$4,'running',$5)`, [runId, workspace.id, owner, randomUUID(), device])
  await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`, [tokenId, owner, hashDeviceToken(credential), device, workspace.id])
  let issued = 0
  const { subscriptionRuntime } = await import('./subscription-runtime')
  mock.module('@/lib/subscription-runtime', { namedExports: {
    subscriptionRuntime: () => ({
      nativeRun: async (userId: string, deviceId: string, id: string) => {
        assert.deepEqual([userId, deviceId, id], [owner, device, runId])
        return { ownerId: owner, workspaceId: workspace.id, runId, execution: 'native' }
      },
      nativeLease: async () => { issued++; return { route: 'claude_code_cli', modelId: 'synthetic-model', revision: 1, accountId: 'synthetic-account', expiresAt: new Date(Date.now() + 60_000).toISOString(), accessToken: 'synthetic-non-provider-token' } },
    } as unknown as ReturnType<typeof subscriptionRuntime>),
  } })
  const route = await import('../app/v1/devices/[deviceId]/runs/[runId]/subscription-lease/route')
  const request = (deviceId = device, id = runId) => new Request(`http://127.0.0.1/mikka/v1/devices/${deviceId}/runs/${id}/subscription-lease`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'x-mikka-device-session': '1' } })
  t.after(async () => {
    mock.restoreAll()
    await pool.query('DELETE FROM thread_machines WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM device_tokens WHERE id=$1', [tokenId])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('./db'), import('./workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  await t.test('the same credential remains valid for its established report route', async () => {
    const caller = await authenticateDevice(new Request(`http://127.0.0.1/v1/devices/${device}/report`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } }))
    assert.equal(caller?.tokenId, tokenId)
  })
  await t.test('a valid session gets an upgrade error and never receives provider credentials', async () => {
    for (const [deviceId, id] of [[device, runId], [otherDevice, otherRun], [device, randomUUID()]]) {
      const response = await route.POST(request(deviceId, id), { params: Promise.resolve({ deviceId, runId: id }) })
      assert.equal(response.status, 410)
      assert.deepEqual(await response.json(), { error: 'subscription_gateway_required' })
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
    }
    assert.equal(issued, 0)
  })
  await t.test('revoked cloud credentials remain refused', async () => {
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
    const before = issued
    const response = await route.POST(request(), { params: Promise.resolve({ deviceId: device, runId }) })
    assert.deepEqual({ status: response.status, issued }, { status: 401, issued: before })
  })
})
