import type { PostHog } from 'posthog-js'
import { posthogConfig } from '@/lib/posthog-config'

// The one way the app reaches PostHog. posthog-js is not on the first-load
// path: it is imported (with lib/analytics/posthog-init.ts, which starts it)
// once the page is idle. Before that, flags read as undefined (not loaded),
// the same value an initialised client gives before its flags arrive.

let client: PostHog | null = null
let loading: Promise<PostHog> | null = null
const readyListeners = new Set<(client: PostHog) => void>()

/**
 * A runtime without posthog-js can stand in for it. The desktop renderer's CSP
 * has no PostHog origin, so apps/desktop/src/renderer/analytics.ts hands every
 * capture to the main process, which applies the same allowlist
 * (lib/analytics-policy.ts) before anything leaves the computer. The callers
 * here and in the official UI keep one code path.
 */
export type AnalyticsTransport = Pick<PostHog, 'capture' | 'identify' | 'reset' | 'register' | 'get_distinct_id' | 'reloadFeatureFlags' | 'onFeatureFlags' | 'getFeatureFlag' | 'has_opted_out_capturing'>
let transport: AnalyticsTransport | null = null

/** Flags read from somewhere other than posthog-js: the desktop's owner-evaluated bootstrap snapshot. */
export type FlagSource = { flag(key: string): boolean | string | undefined; subscribe(notify: () => void): () => void }
let flagSource: FlagSource | null = null

/** Installs the stand-in client; callers waiting in `withPostHog` run now. */
export function setAnalyticsTransport(next: AnalyticsTransport) {
  transport = next
  for (const listener of readyListeners) listener(next as PostHog)
  readyListeners.clear()
}

export function setFlagSource(next: FlagSource | null) {
  flagSource = next
}

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
export const postHogClient = (): PostHog | null => client ?? (transport as PostHog | null)

/** Runs `use` with the client: now if it is loaded, else once it loads. Without a token or a transport, never. */
export function withPostHog(use: (client: PostHog) => void) {
  const ready = client ?? (transport as PostHog | null)
  if (ready) use(ready)
  else if (posthogConfig.token || desktopRenderer()) readyListeners.add(use)
}

/** The bundled desktop window, whose transport registers during startup. */
function desktopRenderer() {
  return typeof window !== 'undefined' && Boolean((window as { mikka?: { bundled?: { telemetry?: unknown } } }).mikka?.bundled?.telemetry)
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
  else if (flagSource) unsubscribe = flagSource.subscribe(notify)
  else if (posthogConfig.token) readyListeners.add(attach)
  return () => {
    active = false
    readyListeners.delete(attach)
    unsubscribe?.()
  }
}

/** A feature flag's value without sending an event; undefined until PostHog (or the desktop's snapshot) has loaded. */
export const postHogFlag = (key: string) => client ? client.getFeatureFlag(key, { send_event: false }) : flagSource?.flag(key)
