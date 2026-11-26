/**
 * T3 — Client-safe Billing Catalog contracts, Zod schemas, formatters, and fetch helper.
 *
 * Strictly free of `server-only`, database, or Node-only imports so Web,
 * Desktop, and native clients can consume server-issued pricing and offers
 * without hardcoding amounts, credit rates, or machine SKU prices.
 */
import { z } from 'zod'
import { withBasePath } from '@/lib/base-path'
import {
  MACHINE_SIZES,
  selectableMachineSizeOptions,
  type MachineSize,
} from '@/lib/cloud-computer/machine-pricing'
import { POINTS_PER_USD, POINTS_PURCHASE_AMOUNTS } from './hosted-usage'

const MICRO_USD_PER_POINT = 1_000_000 / POINTS_PER_USD
const MACHINE_SIZE_IDS = Object.keys(MACHINE_SIZES) as [MachineSize, ...MachineSize[]]
const isoDatetimeSchema = z.iso.datetime({ offset: true })

export const billingPlanCatalogEntrySchema = z.object({
  id: z.string().min(1),
  plan: z.enum(['pro', 'enterprise']),
  name: z.string().min(1),
  stripePriceId: z.string().min(1).nullable(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  interval: z.enum(['month', 'year']),
  includedCreditCents: z.number().int().nonnegative(),
  includedPoints: z.number().int().nonnegative(),
  seatModel: z.enum(['per_workspace', 'per_seat']),
  active: z.boolean(),
}).strict()

export type BillingPlanCatalogEntry = z.infer<typeof billingPlanCatalogEntrySchema>

export const creditConversionSchema = z.object({
  pointsPerUsd: z.number().int().positive(),
  microUsdPerPoint: z.number().int().positive(),
  currency: z.string().min(1),
  displayAmountCents: z.number().int().positive(),
  displayPoints: z.number().int().positive(),
  topUpAmountsUsd: z.array(z.number().positive()).readonly(),
}).strict()

export type CreditConversionMetadata = z.infer<typeof creditConversionSchema>

export const machineSkuCatalogEntrySchema = z.object({
  id: z.enum(MACHINE_SIZE_IDS),
  vcpu: z.number().positive(),
  memoryGib: z.number().positive(),
  hourlyRateCents: z.number().int().nonnegative(),
  hourlyUsd: z.number().nonnegative(),
  isDefault: z.boolean(),
  provider: z.enum(['cloudflare', 'e2b']),
}).strict()

export type MachineSkuCatalogEntry = z.infer<typeof machineSkuCatalogEntrySchema>

export const billingActiveOfferSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.enum(['intro_period', 'discount', 'trial']),
  planId: z.string().min(1),
  introAmountCents: z.number().int().nonnegative(),
  introInterval: z.enum(['week', 'month']),
  regularAmountCents: z.number().int().positive(),
  regularInterval: z.enum(['month', 'year']),
  introCreditCents: z.number().int().nonnegative(),
  endsAt: isoDatetimeSchema,
}).strict()

export type BillingActiveOffer = z.infer<typeof billingActiveOfferSchema>

export const billingCatalogViewSchema = z.object({
  currency: z.string().min(1),
  configured: z.boolean(),
  plans: z.array(billingPlanCatalogEntrySchema),
  creditConversion: creditConversionSchema,
  machineSkus: z.array(machineSkuCatalogEntrySchema),
  activeOffer: billingActiveOfferSchema.nullable(),
  fetchedAt: isoDatetimeSchema,
}).strict()

export type BillingCatalogView = z.infer<typeof billingCatalogViewSchema>

export const DEFAULT_CREDIT_CONVERSION: CreditConversionMetadata = Object.freeze({
  pointsPerUsd: POINTS_PER_USD,
  microUsdPerPoint: MICRO_USD_PER_POINT,
  currency: 'usd',
  displayAmountCents: 100,
  displayPoints: POINTS_PER_USD,
  topUpAmountsUsd: Object.freeze([...POINTS_PURCHASE_AMOUNTS]),
})

/** Derives provisionable machine SKUs from the canonical machine-pricing table. */
export function deriveMachineSkuCatalog(): MachineSkuCatalogEntry[] {
  return selectableMachineSizeOptions().map(option => ({
    id: option.id,
    vcpu: option.vcpu,
    memoryGib: option.ramGib,
    hourlyRateCents: Math.round(option.hourlyUsd * 100),
    hourlyUsd: option.hourlyUsd,
    isDefault: option.isDefault,
    provider: 'cloudflare' as const,
  }))
}

export interface FormatCatalogCurrencyOptions {
  minimumFractionDigits?: number
  maximumFractionDigits?: number
}

/** Formats integer currency cents with locale-appropriate currency formatting. */
export function formatCatalogCurrency(
  amountCents: number,
  currency = 'usd',
  locale = 'en',
  options: FormatCatalogCurrencyOptions = {},
): string {
  const safeCents = Number.isFinite(amountCents) ? amountCents : 0
  const wholeUnit = safeCents % 100 === 0
  const minDigits = options.minimumFractionDigits ?? (wholeUnit ? 0 : 2)
  const maxDigits = options.maximumFractionDigits ?? (wholeUnit ? 0 : 2)
  const normalizedCurrency = /^[a-z]{3}$/i.test(currency.trim()) ? currency.trim().toUpperCase() : 'USD'
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    }).format(safeCents / 100)
  } catch {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    }).format(safeCents / 100)
  }
}

/** Builds structured i18n interpolation parameters for a plan catalog entry. */
export function formatPlanSummaryParams(plan: BillingPlanCatalogEntry, locale = 'en') {
  return {
    id: plan.id,
    plan: plan.plan,
    name: plan.name,
    price: formatCatalogCurrency(plan.amountCents, plan.currency, locale),
    amountCents: plan.amountCents,
    currency: plan.currency.toUpperCase(),
    interval: plan.interval,
    includedCredits: formatCatalogCurrency(plan.includedCreditCents, plan.currency, locale),
    includedCreditCents: plan.includedCreditCents,
    includedPoints: plan.includedPoints,
    formattedPoints: new Intl.NumberFormat(locale).format(plan.includedPoints),
    seatModel: plan.seatModel,
    active: plan.active,
  }
}

/** Builds structured i18n interpolation parameters for a cloud machine SKU entry. */
export function formatMachineSkuParams(
  sku: MachineSkuCatalogEntry,
  currency = 'usd',
  locale = 'en',
) {
  return {
    id: sku.id,
    vcpu: sku.vcpu,
    memoryGib: sku.memoryGib,
    hourlyRateCents: sku.hourlyRateCents,
    hourlyUsd: sku.hourlyUsd,
    hourlyPrice: formatCatalogCurrency(sku.hourlyRateCents, currency, locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    isDefault: sku.isDefault,
    provider: sku.provider,
  }
}

/** Builds structured i18n interpolation parameters for credit-to-USD conversion display. */
export function formatCreditRateParams(
  conversion: CreditConversionMetadata,
  locale = 'en',
) {
  return {
    points: conversion.displayPoints,
    formattedPoints: new Intl.NumberFormat(locale).format(conversion.displayPoints),
    amount: formatCatalogCurrency(conversion.displayAmountCents, conversion.currency, locale),
    amountCents: conversion.displayAmountCents,
    pointsPerUsd: conversion.pointsPerUsd,
    microUsdPerPoint: conversion.microUsdPerPoint,
    currency: conversion.currency.toUpperCase(),
    topUpAmounts: conversion.topUpAmountsUsd.map(usd => ({
      usd,
      points: Math.round(usd * conversion.pointsPerUsd),
      formattedAmount: formatCatalogCurrency(Math.round(usd * 100), conversion.currency, locale),
    })),
  }
}

/** Shared API path for reading the server-resolved billing catalog. */
export function billingCatalogPath(workspaceId?: string | null): string {
  const trimmed = workspaceId?.trim()
  if (!trimmed) return '/api/billing/catalog'
  const query = new URLSearchParams({ workspace: trimmed })
  return `/api/billing/catalog?${query}`
}

/** Shared SWR / read-cache key for the billing catalog. */
export function billingCatalogKey(workspaceId?: string | null): readonly ['billing:catalog', string] {
  return ['billing:catalog', workspaceId?.trim() ?? ''] as const
}

export class BillingCatalogError extends Error {
  constructor(readonly code: string, readonly status: number, options?: ErrorOptions) {
    super(code, options)
    this.name = 'BillingCatalogError'
  }
}

/** Fetches and validates the billing catalog from `/api/billing/catalog`. */
export async function fetchBillingCatalog(
  workspaceId?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<BillingCatalogView> {
  const response = await fetchImpl(withBasePath(billingCatalogPath(workspaceId)), {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof (payload as { error?: unknown } | null)?.error === 'string'
      ? (payload as { error: string }).error
      : 'generic'
    throw new BillingCatalogError(code, response.status)
  }
  return billingCatalogViewSchema.parse(payload)
}
