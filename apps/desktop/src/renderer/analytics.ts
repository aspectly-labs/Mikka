import { setAnalyticsTransport, type AnalyticsTransport } from '@/lib/analytics/posthog'
import { analyticsPath } from '@/lib/analytics-policy'
import type { BundledBridge } from '@mikka/protocol/bridge'

// The desktop renderer has no PostHog SDK: its CSP connects only to the app
// origin. This stand-in takes the calls the web makes on posthog-js (the
// official UI's PostHogAnalytics, ErrorBoundary and RUM reports) and hands each
// event to the main process, which applies the web's allowlist
// (lib/analytics-policy.ts), tags it with the platform, version and source
// revisions, and sends it only while sharing is on. Identity is main's: it uses
// the signed-in account, never an id the renderer names.

type Telemetry = NonNullable<BundledBridge['telemetry']>

/** The stand-in client: the methods callers use on posthog-js, nothing more. */
export function desktopAnalyticsTransport(telemetry: Telemetry, location: { origin: string; pathname: string } = window.location): AnalyticsTransport {
  let distinctId = ''
  const capture = ((event: string, properties?: Record<string, unknown> | null) => {
    try {
      telemetry.capture(event, { $current_url: `${location.origin}${analyticsPath(location.pathname)}`, ...properties })
    } catch {
      // Telemetry never interferes with the product.
    }
    return undefined
  }) as AnalyticsTransport['capture']
  return {
    capture,
    identify: ((id?: string) => { if (typeof id === 'string') distinctId = id }) as AnalyticsTransport['identify'],
    reset: (() => { distinctId = '' }) as AnalyticsTransport['reset'],
    // Super properties are main's to add; the allowlist would drop the renderer's anyway.
    register: (() => {}) as AnalyticsTransport['register'],
    get_distinct_id: () => distinctId,
    // Flags arrive with the bootstrap (client-configuration.ts), not from PostHog.
    reloadFeatureFlags: () => {},
    onFeatureFlags: (() => () => {}) as AnalyticsTransport['onFeatureFlags'],
    getFeatureFlag: (() => undefined) as AnalyticsTransport['getFeatureFlag'],
    has_opted_out_capturing: () => false,
  }
}

let installed = false

/**
 * Called once at startup in the bundled window; a no-op on the web or an older
 * desktop. The official UI's PostHogAnalytics (pageviews, its RUM with
 * `window.onerror` and unhandled rejections) and its ErrorBoundaries then report
 * through this transport as they do through posthog-js on the web.
 */
export function installDesktopAnalytics(target: Window & { mikka?: { bundled?: BundledBridge } }) {
  const telemetry = target.mikka?.bundled?.telemetry
  if (installed || !telemetry) return
  installed = true
  const transport = desktopAnalyticsTransport(telemetry, target.location)
  setAnalyticsTransport(transport)
  // The official UI's own RUM and ErrorBoundary check this before reporting.
  void telemetry.state().then(state => {
    if (!state.enabled) target.document.documentElement.dataset.mikkaTelemetryOptOut = '1'
    else delete target.document.documentElement.dataset.mikkaTelemetryOptOut
  }).catch(() => {})
}
