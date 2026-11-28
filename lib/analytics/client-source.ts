import type { PostHog } from 'posthog-js'

// Where a runtime without the PostHog browser SDK gets its analytics client and flags. The
// desktop renderer's CSP has no PostHog origin, so it registers a stand-in that
// hands each capture to the main process (apps/desktop/src/renderer/analytics.ts)
// and a flag source fed by its bootstrap (client-configuration.ts). This module
// holds only that registry, so the desktop never bundles that SDK;
// lib/analytics/posthog.ts reads it.

/** The methods callers use on the SDK client, which a stand-in implements. */
export type AnalyticsTransport = Pick<PostHog, 'capture' | 'identify' | 'reset' | 'register' | 'get_distinct_id' | 'reloadFeatureFlags' | 'onFeatureFlags' | 'getFeatureFlag' | 'has_opted_out_capturing'>

/** Flags read from somewhere other than the SDK: the desktop's owner-evaluated bootstrap snapshot. */
export type FlagSource = { flag(key: string): boolean | string | undefined; subscribe(notify: () => void): () => void }

let transport: AnalyticsTransport | null = null
let flagSource: FlagSource | null = null
const waiting = new Set<(transport: AnalyticsTransport) => void>()

/** Installs the stand-in client; callers waiting for one run now. */
export function setAnalyticsTransport(next: AnalyticsTransport) {
  transport = next
  for (const listener of waiting) listener(next)
  waiting.clear()
}

export const analyticsTransport = () => transport

/** Runs `use` once a stand-in client is installed. */
export function whenAnalyticsTransport(use: (transport: AnalyticsTransport) => void) {
  if (transport) use(transport)
  else waiting.add(use)
}

export function setFlagSource(next: FlagSource | null) {
  flagSource = next
}

export const currentFlagSource = () => flagSource
