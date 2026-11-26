// Positive fixture for no-provider-or-plan-special-casing: every provider and plan-tier branch below should be flagged.

const FAST_PROVIDERS = ['openai', 'vertex'] as const
const MIXED_PROVIDERS = ['openai', 'internal'] as const
const STREAMING_VENDORS = new Set(['deepseek', 'mistral'])
const PROVIDER_TIMEOUT_MS: Record<string, number> = {
  openai: 30_000,
  anthropic: 45_000,
}

const PAID_TIERS = ['pro', 'enterprise'] as const
const MIXED_TIERS = ['pro', 'custom'] as const
const TIER_CONCURRENCY: Record<string, number> = {
  free: 4,
  pro: 32,
  enterprise: 128,
}

export function inspectProvider(provider: string, aiProvider: string, vendor: string) {
  const isOpenAi = provider === 'openai'
  const isAnthropic = aiProvider.trim().toLowerCase() === 'anthropic'
  const isFast = (FAST_PROVIDERS as readonly string[]).includes(provider)
  const isMixed = (MIXED_PROVIDERS as readonly string[]).includes(provider)
  const hasStream = STREAMING_VENDORS.has(vendor)
  const timeout = PROVIDER_TIMEOUT_MS[provider] ?? 10_000

  let region = 'default'
  switch (provider) {
    case 'google':
      region = 'us-central1'
      break
    case 'bedrock':
      region = 'us-east-1'
      break
  }

  return { isOpenAi, isAnthropic, isFast, isMixed, hasStream, timeout, region }
}

export function inspectPlanTier(
  subscriptionTier: string,
  tier: string,
  planSlug: string,
  pricingTier: string,
  workspaceTier: string,
) {
  const isPro = subscriptionTier === 'pro'
  const isNotFree = tier !== 'free'
  const isEnt = planSlug === 'enterprise'
  const isPaid = (PAID_TIERS as readonly string[]).includes(subscriptionTier)
  const isMixedTier = (MIXED_TIERS as readonly string[]).includes(tier)
  const concurrency = TIER_CONCURRENCY[workspaceTier] ?? 1

  let label = 'Basic'
  switch (pricingTier) {
    case 'starter':
      label = 'Starter'
      break
    case 'max':
      label = 'Max'
      break
  }

  return { isPro, isNotFree, isEnt, isPaid, isMixedTier, concurrency, label }
}
