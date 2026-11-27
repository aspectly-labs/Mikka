import { getNodeEnv } from './env/public.ts'
import { envValue } from './env/runtime.mjs'
// Types only: the other flag registries, so FlagKey covers every declared flag.
import type { DEPLOYMENT_SWITCHES, PERSON_SWITCHES } from './deployment-switches'
import type { LINEAR_SYNC_FLAG } from './linear-sync/flags'
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
  /** Points that bill cloud computer time (计费 › 点数). Hidden while E2B runs on the workspace's own API key (Alex, 2026-10-30). */
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
  /** YYYY-MM-DD the entry was added. */
  added: string
  /** YYYY-MM-DD the flag reached 100%; set it when it does. */
  fullAt?: string
  /** YYYY-MM-DD: at most 60 days after `added` and 14 days after `fullAt`. CI fails the day after. */
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

/** Production capabilities when an installation has no PostHog project.
 * Billing and unshipped experiments remain off. See docs/self-hosting-byok.md. */
export const PRODUCTION_FLAG_DEFAULTS: Readonly<Partial<Record<FlagKey, boolean>>> = {
  'mikka-cloud-computer': true,
  'mikka-computer-billing': false,
  'mikka-memory': false,
  'mikka-byos-subscription-chat': true,
  'mikka-byos-subscription-native': true,
  'mikka-email-sign-in-off': false,
  'mikka-computer-tab-off': false,
  'mikka-proactive-profile': false,
  'mikka-proactive-research': false,
  ...Object.fromEntries(Object.values(upcomingFeatures).map(feature => [feature.key, false])),
  ...Object.fromEntries(Object.keys(releaseFlags).map(key => [key, false])),
}
export const productionFlagDefault = (key: FlagKey) => PRODUCTION_FLAG_DEFAULTS[key] ?? false

/** Local server acceptance can exercise both flag states without a PostHog key.
 * Production ignores this setting before reading or parsing it. */
export function localFlagOverride(key: string): boolean | undefined {
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
    || Object.values(overrides).some(value => typeof value !== 'boolean')) {
    throw new Error('MIKKA_FLAG_OVERRIDES_REQUIRE_BOOLEANS')
  }
  return Object.hasOwn(overrides, key) ? (overrides as Record<string, boolean>)[key] : undefined
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
  | (typeof proactiveFeatures)[keyof typeof proactiveFeatures]
  | (typeof killSwitches)[keyof typeof killSwitches]
  | (typeof DEPLOYMENT_SWITCHES)[keyof typeof DEPLOYMENT_SWITCHES]['flag']
  | (typeof PERSON_SWITCHES)[keyof typeof PERSON_SWITCHES]['flag']
  | (typeof RUNTIME_CONFIG_DEFINITIONS)[keyof typeof RUNTIME_CONFIG_DEFINITIONS]['flag']
  | typeof LINEAR_SYNC_FLAG
  | (typeof SUBSCRIPTION_ROUTE_FLAGS)[keyof typeof SUBSCRIPTION_ROUTE_FLAGS]

/** An explicitly configured Preview can exercise the real cloud UI before rollout. */
export function computerAcceptancePreview(environment: string | undefined, enabled: string | undefined) {
  return environment === 'preview' && enabled === '1'
}

/** Production rollout can be enabled explicitly without changing Preview behavior. */
export function computerProductionEnabled(environment: string | undefined, enabled: string | undefined) {
  return environment === 'production' && enabled === '1'
}
