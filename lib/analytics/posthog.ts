import type { PostHog } from 'posthog-js'
import { posthogConfig } from '@/lib/posthog-config'
import type { FlagKey } from '@/lib/feature-flags'

// The one way the app reaches PostHog. posthog-js is not on the first-load
// path: it is imported (with lib/analytics/posthog-init.ts, which starts it)
// once the page is idle. Before that, flags read as undefined (not loaded),
// the same value an initialised client gives before its flags arrive.

let client: PostHog | null = null
let loading: Promise<PostHog> | null = null
const readyListeners = new Set<(client: PostHog) => void>()

/** Imports and starts PostHog once; every later call returns the same promise. */
export function loadPostHog(): Promise<PostHog> {
  loading ??= Promise.all([import('posthog-js'), import('./posthog-init')]).then(([module]) => {
    client = module.default
    for (const listener of readyListeners) listener(client)
    readyListeners.clear()
    return client
  })
  return loading
}

/** Starts PostHog when the browser is first idle (at most 3 s after this call). */
export function loadPostHogAfterIdle(target: Window) {
  const start = () => { void loadPostHog().catch(() => {}) }
  if (typeof target.requestIdleCallback === 'function') target.requestIdleCallback(start, { timeout: 3000 })
  else target.setTimeout(start, 1)
}

/** The started client, or null while it has not loaded (or analytics is off). */
export const postHogClient = (): PostHog | null => client

/** Runs `use` with the client: now if it is loaded, else once it loads. Without a token, never. */
export function withPostHog(use: (client: PostHog) => void) {
  if (client) use(client)
  else if (posthogConfig.token) readyListeners.add(use)
}

/** `posthog.onFeatureFlags` for a client that may load later: it also notifies once on load. */
export function onPostHogFlags(notify: () => void): () => void {
  let unsubscribe: (() => void) | null = null
  let active = true
  const attach = (ready: PostHog) => {
    if (!active) return
    unsubscribe = ready.onFeatureFlags(() => notify())
    notify()
  }
  if (client) unsubscribe = client.onFeatureFlags(() => notify())
  else if (posthogConfig.token) readyListeners.add(attach)
  return () => {
    active = false
    readyListeners.delete(attach)
    unsubscribe?.()
  }
}

/** A feature flag's value without sending an event; undefined until PostHog has loaded. */
export const postHogFlag = (key: FlagKey) => client?.getFeatureFlag(key, { send_event: false })
