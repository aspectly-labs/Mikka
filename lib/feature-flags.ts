import { getNodeEnv } from './env/public.ts'
import { envValue } from './env/runtime.mjs'

export const upcomingFeatures = {
  product: { key: 'mikka-upcoming-product-features', implemented: false },
  integrations: { key: 'mikka-upcoming-integrations', implemented: false },
  administration: { key: 'mikka-upcoming-administration', implemented: false },
  teamSettings: { key: 'mikka-upcoming-team-settings', implemented: false },
} satisfies Record<string, { key: string; implemented: boolean }>

export type UpcomingFeature = keyof typeof upcomingFeatures

export function featureAvailability(feature: UpcomingFeature, remoteValue: boolean | string | undefined) {
  const capability = upcomingFeatures[feature]
  return {
    enabled: capability.implemented && remoteValue === true,
    key: capability.key,
    reason: remoteValue === true && !capability.implemented
      ? 'FeatureCopy.c_7a3f5896'
      : 'FeatureCopy.c_3760dbb0',
  }
}

/** Built features held back by a PostHog flag until what they depend on is live. */
export interface GatedFeatureDefinition {
  key: string
  /** Public issue this flag is waiting on. Closed issues need an open follow-up. */
  waitsOn?: number
}

export const gatedFeatures = {
  /** The bots' cloud computer UI (#174); the E2B backend (#172) is live. */
  cloudComputer: { key: 'mikka-cloud-computer' },
  /** Environment builds consume the owner's E2B quota; opt in per user. */
  environmentSnapshots: { key: 'mikka-environment-snapshots' },
  /** Points that bill cloud computer time (计费 › 点数). Hidden while E2B runs on the workspace's own API key (Alex, 2026-10-30). */
  computerBilling: { key: 'mikka-computer-billing' },
  /** 记忆 (sidebar entry, its page and its settings section). Hidden: it does not work yet (Alex, 2026-11-20). */
  memory: { key: 'mikka-memory' },
} as const satisfies Record<string, GatedFeatureDefinition>

export type GatedFeature = keyof typeof gatedFeatures

export const taskProviderFlag = 'mikka-task-provider'
export type TaskProviderFlagVariant = 'cloudflare' | 'e2b'
export const isTaskProviderFlagVariant = (value: unknown): value is TaskProviderFlagVariant =>
  value === 'cloudflare' || value === 'e2b'

/** Production capabilities when an installation has no PostHog project.
 * Billing and unshipped experiments remain off. See docs/self-hosting-byok.md. */
export const PRODUCTION_FLAG_DEFAULTS: Readonly<Record<string, boolean | TaskProviderFlagVariant>> = {
  [taskProviderFlag]: 'e2b',
  'mikka-cloud-computer': true,
  'mikka-computer-billing': false,
  'mikka-memory': false,
  'mikka-environment-snapshots': false,
  'mikka-byos-subscription-chat': true,
  'mikka-byos-subscription-native': true,
  'mikka-email-sign-in-off': false,
  'mikka-computer-tab-off': false,
  'mikka-proactive-profile': false,
  'mikka-proactive-research': false,
  // Owner-click analytics (the UI checkout's components/mikka/observability/track-owner-clicks.ts); needs a build
  // made with MIKKA_TRACK_OWNER=1 as well.
  'mikka-track-owner-clicks': false,
  ...Object.fromEntries(Object.values(upcomingFeatures).map(feature => [feature.key, false])),
}
export const productionFlagDefault = (key: string) => PRODUCTION_FLAG_DEFAULTS[key] ?? false

/** Local server acceptance can exercise both flag states without a PostHog key.
 * Production ignores this setting before reading or parsing it. */
export function localFlagOverride(key: string): boolean | TaskProviderFlagVariant | undefined {
  const nodeEnv = getNodeEnv()
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return undefined
  const configured = envValue('MIKKA_FLAG_OVERRIDES')
  if (!configured) return undefined
  let overrides: unknown
  try {
    overrides = JSON.parse(configured)
  } catch (error) {
    throw new Error('MIKKA_FLAG_OVERRIDES_INVALID_JSON', { cause: error })
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Object.entries(overrides).some(([name, value]) => name === taskProviderFlag
      ? !isTaskProviderFlagVariant(value) : typeof value !== 'boolean')) {
    throw new Error('MIKKA_FLAG_OVERRIDES_REQUIRE_BOOLEANS')
  }
  return Object.hasOwn(overrides, key) ? (overrides as Record<string, boolean | TaskProviderFlagVariant>)[key] : undefined
}

/**
 * Who gets proactive work (R-73, docs/design/proactive.md § 3), checked on the
 * server per person (lib/posthog-server.ts) and only once the deployment's
 * switch is on (lib/profile/flags.ts). `research` is reserved for phase 2.
 */
export const proactiveFeatures = {
  profile: 'mikka-proactive-profile',
  research: 'mikka-proactive-research',
} as const

/**
 * Switches that turn a shipped path off while PostHog says exactly true, so a
 * deployment without PostHog (local, CI) keeps it on.
 */
export const killSwitches = {
  /** Email/password sign-in and sign-up; GitHub and Google stay (Alex, 2026-10-30). */
  emailSignIn: 'mikka-email-sign-in-off',
  /** A bot's 电脑 tab in the right panel; shown for every bot unless this is on (Alex, 2026-10-31). */
  computerTab: 'mikka-computer-tab-off',
} as const

/** The approval cache's hint to reread the server's personal-writes capability (use-approval-live); the server decides. */
export const approvalWritesHint = 'mikka-personal-writes-off'

/**
 * Every flag a client reads to decide what the UI shows. The web asks PostHog
 * for them in the browser; the desktop renderer, whose CSP has no PostHog
 * origin, gets them in its bootstrap, evaluated on the server for the same
 * person (lib/desktop-rpc/features.ts) and read through the same
 * `postHogFlag` (lib/analytics/posthog.ts). A flag a client reads must be listed
 * here; nothing else is sent. Security and billing decisions stay on the server.
 */
export const CLIENT_FLAG_KEYS: readonly string[] = [
  ...Object.values(upcomingFeatures).map(feature => feature.key),
  ...Object.values(gatedFeatures).map(feature => feature.key),
  ...Object.values(killSwitches),
  approvalWritesHint,
]

/** On only when PostHog says exactly true; unloaded, missing or multivariate values stay off. */
export function gatedFeatureEnabled(remoteValue: boolean | string | undefined) {
  return remoteValue === true
}

/** An explicitly configured Preview can exercise the real cloud UI before rollout. */
export function computerAcceptancePreview(environment: string | undefined, enabled: string | undefined) {
  return environment === 'preview' && enabled === '1'
}

/** Production rollout can be enabled explicitly without changing Preview behavior. */
export function computerProductionEnabled(environment: string | undefined, enabled: string | undefined) {
  return environment === 'production' && enabled === '1'
}
