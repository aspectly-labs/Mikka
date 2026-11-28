import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CLIENT_VERSION_HEADER,
  DEVICE_SESSION_HEADER,
  DEVICE_SESSION_VERSION,
  MIN_DAEMON_VERSION,
  SOURCE_DAEMON_VERSION,
  UPDATE_REQUIRED_STATUS,
  classifyDeviceRoute,
  daemonUpgradeEdgeResponse,
  deviceSessionSupported,
  legacyDaemonEdgeResponse,
  releasedDaemonVersionTooOld,
} from './daemon-edge-cutoff.mjs'

const req = (path, { method = 'GET', headers = {} } = {}) =>
  new Request(new URL(path, 'https://app.aspectlylabs.com'), { method, headers })

test('edge cutoff device session parser matches decision 2026-11-17-2215 rules', async () => {
  assert.equal(DEVICE_SESSION_HEADER, 'x-mikka-device-session')
  assert.equal(DEVICE_SESSION_VERSION, 1)
  assert.equal(UPDATE_REQUIRED_STATUS, 426)

  for (const value of [undefined, '', '0', 'yes', '1.5', '-1', '9999999']) {
    const sample = req('/mikka/v1/devices/fixture/commands', {
      headers: value === undefined ? {} : { [DEVICE_SESSION_HEADER]: value },
    })
    assert.equal(deviceSessionSupported(sample), false, String(value))
  }
  for (const value of ['1', ' 1 ', '2', '999999']) {
    const sample = req('/mikka/v1/devices/fixture/commands', {
      headers: { [DEVICE_SESSION_HEADER]: value },
    })
    assert.equal(deviceSessionSupported(sample), true, value)
  }
  const edge = daemonUpgradeEdgeResponse('GET')
  assert.equal(edge.status, 426)
  assert.equal(edge.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await edge.json(), {
    error: 'update_required',
    code: 'daemonUpgradeRequired',
    minVersion: MIN_DAEMON_VERSION,
    daemonVersions: { min: MIN_DAEMON_VERSION },
    message: 'Update the Mikka daemon and sign in again.',
  })
})

test('every declared route in apps/api/generated/routes.json matches edge cutoff classification with zero false positives', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/api/generated/routes.json', import.meta.url), 'utf8'))
  assert.ok(manifest.routes.length > 0)
  let deviceRoutes = 0
  let nonDeviceRoutes = 0
  for (const route of manifest.routes) {
    const source = await readFile(new URL('../' + route.source, import.meta.url), 'utf8')
    const usesWithDeviceRoute = source.includes('withDeviceRoute(')
    const concretePath = route.path
      .replace(/\[\.\.\.[^\]]+\]/g, 'a/b')
      .replace(/\[[^\]]+\]/g, '00000000-0000-4000-8000-000000000001')
    const kind = classifyDeviceRoute(concretePath)
    if (usesWithDeviceRoute) {
      deviceRoutes++
      assert.equal(kind, 'device-route', `withDeviceRoute route must be covered at the edge: ${route.path}`)
    } else {
      nonDeviceRoutes++
      assert.equal(kind, null, `non-device route must pass through untouched: ${route.path}`)
    }
  }
  assert.ok(deviceRoutes >= 29, `expected >=29 withDeviceRoute routes, saw ${deviceRoutes}`)
  assert.ok(nonDeviceRoutes >= 400, `expected >=400 non-device routes, saw ${nonDeviceRoutes}`)
})

test('live legacy desktop daemon traffic (0.0.357, 0.0.524, 0.0.701 without device session) is rejected at edge with HTTP 426', async () => {
  const deviceId = '00000000-0000-4000-8000-000000000001'
  const cases = [
    ['GET', `/mikka/v1/devices/${deviceId}/commands`, '0.0.357'],
    ['GET', `/mikka/v1/devices/${deviceId}/commands`, '0.0.524'],
    ['GET', `/mikka/v1/devices/${deviceId}/commands`, '0.0.701'],
    ['GET', `/mikka/v1/devices/${deviceId}/runs`, '0.0.357'],
    ['GET', `/mikka/v1/devices/${deviceId}/runs`, '0.0.524'],
    ['GET', `/mikka/v1/devices/${deviceId}/runs`, '0.0.701'],
    ['GET', `/mikka/v1/devices/${deviceId}/gateway`, '0.0.357'],
    ['GET', `/mikka/v1/devices/${deviceId}/gateway`, '0.0.524'],
    ['GET', `/mikka/v1/devices/${deviceId}/gateway`, '0.0.701'],
    ['POST', `/mikka/v1/devices/${deviceId}/heartbeat`, '0.0.357'],
    ['POST', `/mikka/v1/devices/${deviceId}/heartbeat`, '0.0.524'],
    ['POST', `/mikka/v1/devices/${deviceId}/heartbeat`, '0.0.701'],
    ['POST', `/mikka/v1/devices/${deviceId}/heartbeat/`, '0.0.524'],
    ['POST', `/mikka/%761/devices/${deviceId}/commands`, '0.0.524'],
    ['POST', '/mikka/v1/devices/register', '0.0.524'],
    ['POST', `/mikka/v1/runs/${deviceId}/events`, '0.0.524'],
    ['POST', '/mikka/v1/devices/enroll%2F..%2Fregister', '0.0.524'],
  ]
  for (const [method, path, version] of cases) {
    const response = legacyDaemonEdgeResponse(req(path, {
      method,
      headers: { authorization: 'Bearer fixture', [CLIENT_VERSION_HEADER]: version },
    }))
    assert.ok(response, `expected edge cutoff for ${method} ${path} (${version})`)
    assert.equal(response.status, 426, `${method} ${path}`)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const body = await response.json()
    assert.deepEqual(body, {
      error: 'update_required',
      code: 'daemonUpgradeRequired',
      minVersion: MIN_DAEMON_VERSION,
      daemonVersions: { min: MIN_DAEMON_VERSION },
      message: 'Update the Mikka daemon and sign in again.',
    })
  }
})

test('retired /v1/devices/:id/heartbeat is rejected even if a caller sends a device session header', async () => {
  const deviceId = '00000000-0000-4000-8000-000000000001'
  const response = legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/heartbeat`, {
    method: 'POST',
    headers: { [DEVICE_SESSION_HEADER]: String(DEVICE_SESSION_VERSION), [CLIENT_VERSION_HEADER]: '0.0.701' },
  }))
  assert.ok(response)
  assert.equal(response.status, 410)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal((await response.json()).code, 'heartbeatRetired')

  const head = legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/heartbeat`, { method: 'HEAD' }))
  assert.equal(head?.status, 426)
  assert.equal(await head?.text(), '')

  const headGone = legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/heartbeat`, {
    method: 'HEAD',
    headers: { [DEVICE_SESSION_HEADER]: String(DEVICE_SESSION_VERSION) },
  }))
  assert.equal(headGone?.status, 410)
  assert.equal(await headGone?.text(), '')
})

test('semver floor rejects explicitly outdated released versions while preserving cloud workers and source daemons', () => {
  for (const old of ['0.0.0', '0.0.329', '0.0.357', '0.0.455', 'v0.0.455', '0.0.455-rc.1']) {
    assert.equal(releasedDaemonVersionTooOld(old), true, old)
  }
  for (const allowed of [null, undefined, '', SOURCE_DAEMON_VERSION, MIN_DAEMON_VERSION, '0.0.456-beta.1', '0.0.701', '0.1.0', '1.0.0', 'not-semver']) {
    assert.equal(releasedDaemonVersionTooOld(allowed), false, String(allowed))
  }
  const deviceId = '00000000-0000-4000-8000-000000000001'
  assert.equal(legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/report`, {
    method: 'POST',
    headers: { [DEVICE_SESSION_HEADER]: '1', [CLIENT_VERSION_HEADER]: '0.0.455' },
  }))?.status, 426)
  assert.equal(legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/report`, {
    method: 'POST',
    headers: { [DEVICE_SESSION_HEADER]: '1', [CLIENT_VERSION_HEADER]: MIN_DAEMON_VERSION },
  })), null)
  assert.equal(legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/report`, {
    method: 'POST',
    headers: { [DEVICE_SESSION_HEADER]: '1', [CLIENT_VERSION_HEADER]: SOURCE_DAEMON_VERSION },
  })), null)
  assert.equal(legacyDaemonEdgeResponse(req(`/mikka/v1/devices/${deviceId}/report`, {
    method: 'POST',
    headers: { [DEVICE_SESSION_HEADER]: '1' },
  })), null, 'scoped cloud worker omitting x-mikka-client-version passes through')
})

test('current daemons, enrollment, internal gateway reports, sandbox routes, OPTIONS probes, Web, Mobile, Auth and Eve pass through untouched', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const currentHeaders = { [DEVICE_SESSION_HEADER]: '1', [CLIENT_VERSION_HEADER]: '0.0.800', authorization: 'Bearer fixture' }
  const allowed = [
    req('/mikka/v1/devices/register', { method: 'POST', headers: currentHeaders }),
    req(`/mikka/v1/devices/${id}/report`, { method: 'POST', headers: currentHeaders }),
    req(`/mikka/v1/devices/${id}/commands`, { method: 'GET', headers: currentHeaders }),
    req(`/mikka/v1/devices/${id}/gateway`, { method: 'GET', headers: currentHeaders }),
    req(`/mikka/v1/devices/${id}/runs`, { method: 'GET', headers: currentHeaders }),
    req(`/mikka/v1/runs/${id}/events`, { method: 'POST', headers: currentHeaders }),
    // Enrollment without x-mikka-device-session (scripts/ops/production-mobile-daemon.mjs)
    req('/mikka/v1/devices/enroll', { method: 'POST', headers: { authorization: 'Bearer orv_fixture' } }),
    req('/mikka/v1/devices/%65nroll', { method: 'POST', headers: { authorization: 'Bearer orv_fixture' } }),
    // Non-daemon /v1/ routes
    req(`/mikka/v1/internal/device-sessions/${id}`, { method: 'POST', headers: { authorization: 'Bearer gateway-secret' } }),
    req('/mikka/v1/mailbox', { method: 'POST', headers: { authorization: 'Bearer run-token' } }),
    req(`/mikka/v1/task-secrets/${id}`, { method: 'POST', headers: { authorization: 'Bearer cap-token' } }),
    // Anonymous OPTIONS method probes (scripts/ops/route-probe.mjs)
    req('/mikka/v1/devices/register', { method: 'OPTIONS' }),
    req(`/mikka/v1/devices/${id}/commands`, { method: 'OPTIONS' }),
    req(`/mikka/v1/runs/${id}/events`, { method: 'OPTIONS' }),
    // Web, Mobile, Better Auth, Eve, Cloud, Static
    req('/mikka/api/auth/get-session', { method: 'GET' }),
    req('/mikka/api/version', { method: 'GET' }),
    req('/mikka/api/rpc', { method: 'POST' }),
    req('/mikka/api/mobile/threads', { method: 'GET' }),
    req('/mikka/api/webhooks/github', { method: 'POST' }),
    req('/mikka/api/internal/eve/tools', { method: 'POST' }),
    req('/mikka/cloud/v1/github/webhook', { method: 'POST' }),
    req('/mikka/en/sign-in', { method: 'GET' }),
    req('/mikka/assets/main.js', { method: 'GET' }),
    // Malformed percent-encoding passes through to existing 400 handling
    req('/mikka/v1/devices/%E0%A4%A/commands', { method: 'GET' }),
  ]
  for (const sample of allowed) {
    assert.equal(legacyDaemonEdgeResponse(sample), null, `${sample.method} ${sample.url}`)
  }
})
