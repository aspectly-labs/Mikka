import { CLIENT_FLAG_KEYS } from '@/lib/feature-flags'
import { setFlagSource } from '@/lib/analytics/client-source'
import { installDesktopAnalytics } from './analytics'

export type DesktopFeatures = { flags: Record<string, boolean>; cloudComputer: boolean }
export type DesktopPublicConfiguration = { features: DesktopFeatures; daemonPackageName: string }
const defaults = (): DesktopPublicConfiguration => ({ features: { flags: Object.fromEntries(CLIENT_FLAG_KEYS.map(key => [key, false])), cloudComputer: false }, daemonPackageName: '@aspectlylabs/mikka' })
let configuration = defaults()
/** Whether a bootstrap has delivered flags; until then they read as not loaded, as on the web. */
let loaded = false
const listeners = new Set<() => void>()

/** The existing bootstrap carries a public, owner-evaluated snapshot. No
 * telemetry SDK, remote script, flag refresh request or timer runs here. */
export function setClientConfiguration(value?: Partial<DesktopPublicConfiguration> | null) {
  const next = defaults()
  for (const key of CLIENT_FLAG_KEYS) next.features.flags[key] = value?.features?.flags?.[key] === true
  next.features.cloudComputer = value?.features?.cloudComputer === true
  if (typeof value?.daemonPackageName === 'string') next.daemonPackageName = value.daemonPackageName
  const nextLoaded = Boolean(value?.features)
  if (loaded === nextLoaded && configuration.daemonPackageName === next.daemonPackageName && configuration.features.cloudComputer === next.features.cloudComputer && CLIENT_FLAG_KEYS.every(key => configuration.features.flags[key] === next.features.flags[key])) return
  configuration = next
  loaded = nextLoaded
  for (const listener of listeners) listener()
}

export function getClientConfiguration() { return configuration }
export function subscribeClientConfiguration(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The official UI reads flags with `postHogFlag` (lib/analytics/posthog.ts), as on
 * the web. Here they come from the snapshot above, which the server evaluated
 * for the same person in the same PostHog project; a flag outside
 * CLIENT_FLAG_KEYS, or any flag before the first bootstrap, reads undefined so
 * the caller keeps its default.
 */
export function snapshotFlag(key: string): boolean | undefined {
  return loaded && CLIENT_FLAG_KEYS.includes(key) ? configuration.features.flags[key] : undefined
}

// The official UI's app shell imports this module on the web too; only the bundled desktop window uses the snapshot.
if (typeof window !== 'undefined' && (window as { mikka?: { bundled?: unknown } }).mikka?.bundled) {
  setFlagSource({ flag: snapshotFlag, subscribe: subscribeClientConfiguration })
  installDesktopAnalytics(window)
}
