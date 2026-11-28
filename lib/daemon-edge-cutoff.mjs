// Pure Web-Standard edge cutoff for retired legacy desktop daemons
// (decision 2026-11-17-2215). Shared by both the public app gateway
// (cloudflare/web/gateway.mjs) and the private API ingress Worker
// (cloudflare/api/ingress/worker.mjs) so legacy daemon polls and retired
// heartbeats never wake the BusinessApi Container.
//
// Keep zero Node built-in or npm dependencies: gateway.mjs bundles without
// nodejs_compat and ingress/worker.mjs bundles with only @cloudflare/containers.
// Parity with @mikka/protocol and lib/daemon-release.ts is enforced by
// lib/daemon-edge-cutoff.test.mjs.

export const DEVICE_SESSION_HEADER = 'x-mikka-device-session'
export const DEVICE_SESSION_VERSION = 1
export const CLIENT_VERSION_HEADER = 'x-mikka-client-version'
export const MIN_DAEMON_VERSION = '0.0.456'
export const SOURCE_DAEMON_VERSION = '0.0.1'
export const UPDATE_REQUIRED_STATUS = 426

const MIN_PARTS = MIN_DAEMON_VERSION.split('.').map(Number)
const SEMVER_RE = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:[-+][^\s]*)?$/
const RETIRED_HEARTBEAT_RE = /^devices\/[^/]+\/heartbeat$/

const UPGRADE_BODY = JSON.stringify({
  error: 'update_required',
  code: 'daemonUpgradeRequired',
  minVersion: MIN_DAEMON_VERSION,
  daemonVersions: { min: MIN_DAEMON_VERSION },
  message: 'Update the Mikka daemon and sign in again.',
})

const HEARTBEAT_RETIRED_BODY = JSON.stringify({
  error: 'endpoint_retired',
  code: 'heartbeatRetired',
  message: 'Device heartbeats are retired. Update the Mikka daemon and sign in again.',
})

const EDGE_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
}

/** Exact device-session contract from lib/daemon-release.ts. */
export function deviceSessionSupported(request) {
  const value = request.headers.get(DEVICE_SESSION_HEADER)?.trim()
  return value !== undefined && /^[0-9]{1,6}$/.test(value) && Number(value) >= DEVICE_SESSION_VERSION
}

/**
 * Conservative edge floor check for explicitly supplied released semvers.
 * Missing headers (scoped cloud workers) and SOURCE_DAEMON_VERSION pass
 * through to BusinessApi so cloud/source invariants remain untouched.
 */
export function releasedDaemonVersionTooOld(version) {
  if (typeof version !== 'string') return false
  const trimmed = version.trim()
  if (!trimmed || trimmed === SOURCE_DAEMON_VERSION) return false
  const match = SEMVER_RE.exec(trimmed)
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== MIN_PARTS[i]) return parts[i] < MIN_PARTS[i]
  }
  return false
}

/**
 * Classify whether a URL pathname targets a daemon device/run route that
 * requires a device session (or the retired /v1/devices/:id/heartbeat route).
 * Non-daemon /v1/ routes (enroll, internal/device-sessions, mailbox,
 * task-secrets) and all /api/, /cloud/, /.well-known/, and Web page/asset
 * paths return null and pass through untouched.
 */
export function classifyDeviceRoute(pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (!decoded || decoded.includes('\\')) return null
  const normalized = decoded.length > 1 ? decoded.replace(/\/+$/, '') : decoded
  const match = /^\/(?:mikka\/)?v1\/(.+)$/.exec(normalized)
  if (!match) return null
  const rest = match[1]
  if (rest.startsWith('devices/')) {
    if (rest === 'devices/enroll') return null
    if (RETIRED_HEARTBEAT_RE.test(rest)) return 'retired-heartbeat'
    return 'device-route'
  }
  if (rest.startsWith('runs/')) return 'device-route'
  return null
}

/** Exact HTTP 426 upgrade refusal matching lib/daemon-release.ts daemonUpgradeResponse(). */
export function daemonUpgradeEdgeResponse(method = 'GET') {
  return new Response(method.toUpperCase() === 'HEAD' ? null : UPGRADE_BODY, {
    status: UPDATE_REQUIRED_STATUS,
    headers: EDGE_HEADERS,
  })
}

/** HTTP 410 Gone for the permanently removed /v1/devices/:id/heartbeat route. */
export function retiredHeartbeatEdgeResponse(method = 'GET') {
  return new Response(method.toUpperCase() === 'HEAD' ? null : HEARTBEAT_RETIRED_BODY, {
    status: 410,
    headers: EDGE_HEADERS,
  })
}

/**
 * Returns an immediate edge refusal Response if the request comes from a
 * retired/outdated legacy desktop daemon or targets the removed heartbeat
 * endpoint, or null if the request should proceed normally to BusinessApi.
 */
export function legacyDaemonEdgeResponse(request) {
  const method = request.method.toUpperCase()
  // Preserve anonymous OPTIONS method discovery (scripts/ops/route-probe.mjs) and CORS preflight.
  if (method === 'OPTIONS') return null
  let pathname
  try { pathname = new URL(request.url).pathname } catch { return null }
  const kind = classifyDeviceRoute(pathname)
  if (!kind) return null
  if (!deviceSessionSupported(request) || releasedDaemonVersionTooOld(request.headers.get(CLIENT_VERSION_HEADER))) {
    return daemonUpgradeEdgeResponse(method)
  }
  if (kind === 'retired-heartbeat') return retiredHeartbeatEdgeResponse(method)
  return null
}
