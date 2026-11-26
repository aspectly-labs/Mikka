/**
 * T4 — Typed Remote Runtime Config definitions and Zod schemas.
 *
 * Every runtime-mutable operational or promotional setting is registered in
 * `RUNTIME_CONFIG_DEFINITIONS` with a unique PostHog flag key, owner,
 * description, optional environment scope, strict Zod schema, and safe
 * schema-validated fallback.
 */
import { z } from 'zod'

export type RuntimeConfigEnvironment = 'production' | 'preview' | 'local'

export interface RuntimeConfigDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly key: string
  readonly flag: string
  readonly owner: string
  readonly description: string
  readonly environments?: readonly RuntimeConfigEnvironment[]
  readonly schema: TSchema
  readonly fallback: z.infer<TSchema>
}

export const RUNTIME_CONFIG_FLAG_PATTERN = /^mikka-config-[a-z0-9-]+$/

const isoDatetimeSchema = z.iso.datetime({ offset: true })
const httpUrlSchema = z.url({ protocol: /^https?$/ })

export const announcementBannerPayloadSchema = z.object({
  enabled: z.boolean(),
  id: z.string().min(1),
  message: z.string(),
  href: httpUrlSchema.optional(),
  tone: z.enum(['info', 'warning', 'success']).default('info'),
  startAt: isoDatetimeSchema.optional(),
  endAt: isoDatetimeSchema.optional(),
}).strict()

export type AnnouncementBannerPayload = z.infer<typeof announcementBannerPayloadSchema>

export const billingActiveOfferPayloadSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['intro_period', 'discount', 'trial']),
  planId: z.string().min(1),
  introAmountCents: z.number().int().nonnegative(),
  introInterval: z.enum(['week', 'month']),
  regularAmountCents: z.number().int().positive(),
  regularInterval: z.enum(['month', 'year']),
  introCreditCents: z.number().int().nonnegative(),
  stripeCouponId: z.string().min(1).optional(),
  stripeIntroPriceId: z.string().min(1).optional(),
  startAt: isoDatetimeSchema.optional(),
  endAt: isoDatetimeSchema,
}).strict()

export type BillingActiveOfferPayload = z.infer<typeof billingActiveOfferPayloadSchema>

export const operationalCapsPayloadSchema = z.object({
  maxWorkspaceBudgets: z.number().int().positive(),
  maxConcurrentRunsOverride: z.number().int().positive().nullable(),
  startAt: isoDatetimeSchema.optional(),
  endAt: isoDatetimeSchema.optional(),
}).strict()

export type OperationalCapsPayload = z.infer<typeof operationalCapsPayloadSchema>

export const planEntitlementOverridesPayloadSchema = z.object({
  approvalTemplateLimit: z.object({
    free: z.number().int().nonnegative().optional(),
    pro: z.number().int().nonnegative().optional(),
    enterprise: z.number().int().nonnegative().optional(),
    community: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  hostedMaxInFlight: z.object({
    free: z.number().int().positive().optional(),
    pro: z.number().int().positive().optional(),
    enterprise: z.number().int().positive().optional(),
  }).strict().optional(),
  startAt: isoDatetimeSchema.optional(),
  endAt: isoDatetimeSchema.optional(),
}).strict()

export type PlanEntitlementOverridesPayload = z.infer<typeof planEntitlementOverridesPayloadSchema>

export const RUNTIME_CONFIG_DEFINITIONS = {
  announcementBanner: {
    key: 'announcementBanner',
    flag: 'mikka-config-announcement-banner',
    owner: 'platform-ops',
    description: 'Workspace-wide announcement banner displayed when enabled and inside its active time window.',
    schema: announcementBannerPayloadSchema,
    fallback: Object.freeze({ enabled: false, id: 'none', message: '', tone: 'info' as const }),
  },
  billingActiveOffer: {
    key: 'billingActiveOffer',
    flag: 'mikka-config-billing-active-offer',
    owner: 'billing',
    description: 'Time-bounded introductory billing offer or promotional discount configuration.',
    schema: billingActiveOfferPayloadSchema.nullable(),
    fallback: null,
  },
  operationalCaps: {
    key: 'operationalCaps',
    flag: 'mikka-config-operational-caps',
    owner: 'platform-ops',
    description: 'Runtime operational safety caps and temporary concurrent-run limit overrides.',
    schema: operationalCapsPayloadSchema,
    fallback: Object.freeze({ maxWorkspaceBudgets: 200, maxConcurrentRunsOverride: null }),
  },
  planEntitlementOverrides: {
    key: 'planEntitlementOverrides',
    flag: 'mikka-config-plan-entitlement-overrides',
    owner: 'governance',
    description: 'Temporary runtime overrides for plan entitlement limits such as approval templates and hosted concurrency.',
    schema: planEntitlementOverridesPayloadSchema.nullable(),
    fallback: null,
  },
} as const satisfies Record<string, RuntimeConfigDefinition<z.ZodTypeAny>>

export type RuntimeConfigKey = keyof typeof RUNTIME_CONFIG_DEFINITIONS
export type RuntimeConfigValue<K extends RuntimeConfigKey> = z.infer<(typeof RUNTIME_CONFIG_DEFINITIONS)[K]['schema']>
export type RuntimeConfigInput<K extends RuntimeConfigKey> = z.input<(typeof RUNTIME_CONFIG_DEFINITIONS)[K]['schema']>
