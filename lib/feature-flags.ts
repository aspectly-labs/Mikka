import { getNodeEnv } from './env/public.ts'
import { envValue } from './env/runtime.mjs'
// Types only: the other flag registries, so FlagKey covers every declared flag.
import type { DEPLOYMENT_SWITCHES, PERSON_SWITCHES } from './deployment-switches'
import type { RUNTIME_CONFIG_DEFINITIONS } from './runtime-config/schema'
import type { SUBSCRIPTION_ROUTE_FLAGS } from './subscription-routes'

export const upcomingFeatures = {
  product: { key: 'mikka-upcoming-product-features', implemented: false },
  integrations: { key: 'mikka-upcoming-integrations', implemented: false },
  administration: { key: 'mikka-upcoming-administration', implemented: false },
  teamSettings: { key: 'mikka-upcoming-team-settings', implemented: false },
} as const satisfies Record<string, { key: string; implemented: boolean }>

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
  /** The points meters in 计费 › 点数. Off in PostHog since 2026-11-27 (Alex): billing moves to one dollar-denominated balance for models and cloud computer time, and these meters are replaced, not shown (#3369). */
  computerBilling: { key: 'mikka-computer-billing' },
  /** 记忆 (sidebar entry, its page and its settings section). Hidden: it does not work yet (Alex, 2026-11-20). */
  memory: { key: 'mikka-memory' },
} as const satisfies Record<string, GatedFeatureDefinition>

export type GatedFeature = keyof typeof gatedFeatures

/** A staged rollout of a risky change (mikka-hosted-ui/docs/design/decisions/2026-11-27-0330-staged-rollout-release-flags.md). */
export interface ReleaseFlagDefinition {
  /** Who widens the stages and deletes the flag. */
  owner: string
  /** The risky change the flag guards. */
  description: string
  /** YYYY-MM-DD (UTC) the entry was added; tomorrow in UTC is accepted. */
  added: string
  /** YYYY-MM-DD (UTC) the flag reached 100%; set it when it does. */
  fullAt?: string
  /** YYYY-MM-DD (UTC): at most 60 days after `added` and 14 days after `fullAt`. CI fails from 00:00 UTC the day after. */
  removeBy: string
}

/**
 * Release flags, by PostHog key. Each is a gate: the new path runs only while
 * PostHog answers exactly true for the person (releaseFlagEnabled). While flags
 * load, when PostHog is unreachable, and without a PostHog project, the
 * previous behaviour runs. Stages: internal, a small percentage, then 100%. At
 * 100% delete the entry, the flag and the dead branch.
 * scripts/feature-flags-policy.mjs enforces the dates.
 */
export const releaseFlags = {} as const satisfies Record<string, ReleaseFlagDefinition>

export type ReleaseFlag = keyof typeof releaseFlags

export const taskProviderFlag = 'mikka-task-provider'
export type TaskProviderFlagVariant = 'cloudflare' | 'e2b'
export const isTaskProviderFlagVariant = (value: unknown): value is TaskProviderFlagVariant =>
  value === 'cloudflare' || value === 'e2b'

/** Owner-click analytics (the UI checkout's components/mikka/observability/track-owner-clicks.ts); needs a build made with MIKKA_TRACK_OWNER=1 as well. */
export const ownerClickAnalyticsFlag = 'mikka-track-owner-clicks'

/** Production capabilities when an installation has no PostHog project.
 * Billing and unshipped experiments remain off. See docs/self-hosting-byok.md. */
export const PRODUCTION_FLAG_DEFAULTS: Readonly<Partial<Record<FlagKey, boolean | TaskProviderFlagVariant>>> = {
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
  ...Object.fromEntries(Object.keys(releaseFlags).map(key => [key, false])),
}
export const productionFlagDefault = (key: FlagKey) => PRODUCTION_FLAG_DEFAULTS[key] ?? false

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

/**
 * Every flag a client reads to decide what the UI shows. The web asks PostHog
 * for them in the browser; the desktop renderer, whose CSP has no PostHog
 * origin, gets them in its bootstrap, evaluated on the server for the same
 * person (lib/desktop-rpc/features.ts) and read through the same
 * `postHogFlag` (lib/analytics/posthog.ts). A flag a client reads must be listed
 * here; nothing else is sent. Security and billing decisions stay on the server.
 */
export const CLIENT_FLAG_KEYS: readonly FlagKey[] = [
  ...Object.values(upcomingFeatures).map(feature => feature.key),
  ...Object.values(gatedFeatures).map(feature => feature.key),
  ...Object.values(killSwitches),
  ...(Object.keys(releaseFlags) as ReleaseFlag[]),
]

/** On only when PostHog says exactly true; unloaded, missing or multivariate values stay off. */
export function gatedFeatureEnabled(remoteValue: boolean | string | undefined) {
  return remoteValue === true
}

/** A release flag's new path: on only when PostHog says exactly true, so loading, unreachable and no-PostHog keep the previous behaviour. */
export function releaseFlagEnabled(key: ReleaseFlag, remoteValue: boolean | string | undefined) {
  return Object.hasOwn(releaseFlags, key) && remoteValue === true
}

/**
 * Every PostHog flag key a registry declares. Flag reads (postHogFlag,
 * serverFlagEnabled, productionFlagDefault) take only these, so an undeclared
 * key fails `pnpm typecheck`; scripts/feature-flags-policy.mjs is the backstop.
 */
export type FlagKey =
  | (typeof upcomingFeatures)[UpcomingFeature]['key']
  | (typeof gatedFeatures)[GatedFeature]['key']
  | ReleaseFlag
  | typeof taskProviderFlag
  | typeof ownerClickAnalyticsFlag
  | (typeof proactiveFeatures)[keyof typeof proactiveFeatures]
  | (typeof killSwitches)[keyof typeof killSwitches]
  | (typeof DEPLOYMENT_SWITCHES)[keyof typeof DEPLOYMENT_SWITCHES]['flag']
  | (typeof PERSON_SWITCHES)[keyof typeof PERSON_SWITCHES]['flag']
  | (typeof RUNTIME_CONFIG_DEFINITIONS)[keyof typeof RUNTIME_CONFIG_DEFINITIONS]['flag']
  | (typeof SUBSCRIPTION_ROUTE_FLAGS)[keyof typeof SUBSCRIPTION_ROUTE_FLAGS]

/** An explicitly configured Preview can exercise the real cloud UI before rollout. */
export function computerAcceptancePreview(environment: string | undefined, enabled: string | undefined) {
  return environment === 'preview' && enabled === '1'
}

/** Production rollout can be enabled explicitly without changing Preview behavior. */
export function computerProductionEnabled(environment: string | undefined, enabled: string | undefined) {
  return environment === 'production' && enabled === '1'
}
