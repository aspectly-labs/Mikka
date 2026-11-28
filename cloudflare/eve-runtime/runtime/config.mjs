/** Platform deployment data only. Customer connections remain in Mikka's stores. */
export const EVE_PUBLIC_PREFIX = '/mikka/api/agents'
export function hostConfiguration(env) {
  const publicOrigin = env.EVE_PUBLIC_ORIGIN
  const runtime = Object.fromEntries(Object.entries(env)
    .filter(([key]) => key.startsWith('EVE_ENV_')
      && key !== 'EVE_ENV_WORKFLOW_POSTGRES_POLL_INTERVAL_MS')
    .map(([key, value]) => [key.slice('EVE_ENV_'.length), value]))
  return {
    releaseId: env.EVE_RELEASE_ID, sourceSha: env.EVE_SOURCE_SHA, uiSha: env.EVE_UI_SHA,
    publicOrigin,
    runtimeEnv: {
      // The image records the World it was built with; the release pipeline
      // supplies EVE_ENV_WORKFLOW_TARGET_WORLD to match it when a release ships
      // a queue-driven World.
      WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
      ...runtime, NODE_ENV: 'production', MIKKA_EVE_HOST: 'cloudflare',
      MIKKA_DEPLOYMENT_ID: env.EVE_RELEASE_ID, WORKFLOW_DEPLOYMENT_ID: env.EVE_RELEASE_ID, MIKKA_EVE_PUBLIC_ORIGIN: publicOrigin,
      MIKKA_BUILD_REVISION: env.EVE_SOURCE_SHA, MIKKA_UI_OVERLAY_SHA: env.EVE_UI_SHA,
      MIKKA_EVE_RELEASE_ID: env.EVE_RELEASE_ID,
    },
  }
}

// Preserve the name previously supplied by @cloudflare/containers 0.3.7 when no release was configured.
export const singletonContainerName = 'cf-singleton-container'

/** Host residency is an explicit deployment choice, not an ambient default.
 * `resident` keeps the shipped keepalive for releases whose World needs a live
 * process (the Postgres World's Graphile worker polls and LISTEN/NOTIFYs).
 * `on-demand` lets the container sleep between requests; it is honored only
 * when the configured World delivers queued work through the native queues
 * (the `@mikka/eve-cloudflare-world` transport), because queue delivery itself
 * wakes the host. Any other value, or `on-demand` with the Postgres World,
 * stays resident. */
export function hostResidency(env) {
  return env.MIKKA_EVE_HOST_RESIDENCY === 'on-demand' ? 'on-demand' : 'resident'
}

/** True only when on-demand residency can actually take effect. */
export function onDemandHost(env, runtimeEnv) {
  return hostResidency(env) === 'on-demand' && runtimeEnv.WORKFLOW_TARGET_WORLD !== '@workflow/world-postgres'
}

/** Keep the existing namespaced native protocol; do not capture business API routes. */
export function nativeRequest(request) {
  const url = new URL(request.url)
  let path
  if (url.pathname === '/mikka/api/webhooks/slack' || url.pathname === '/mikka/api/webhooks/slack/') {
    path = '/eve/v1/slack'
  } else if (url.pathname.startsWith(EVE_PUBLIC_PREFIX + '/')) {
    path = url.pathname.slice(EVE_PUBLIC_PREFIX.length)
  } else return null
  if (!path.startsWith('/eve/v1/')
    || /[\\?#]/.test(path) || /%2f|%5c|%2e|\/\.\.?\//i.test(path)) return null
  const headers = new Headers(request.headers)
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1))
  url.pathname = path
  return new Request(url, {
    method: request.method, headers, signal: request.signal,
    ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}),
  })
}
