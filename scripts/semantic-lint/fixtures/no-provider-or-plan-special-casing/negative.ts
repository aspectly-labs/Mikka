// Negative fixture for no-provider-or-plan-special-casing: declarative capabilities, event triage tiers, speed tiers, and non-LLM providers.

export interface ModelAdapter {
  readonly id: string
  readonly timeoutMs: number
  supportsStreaming(): boolean
}

export function resolveAdapterTimeout(adapter: ModelAdapter): number {
  return adapter.supportsStreaming() ? adapter.timeoutMs : 10_000
}

export function canExportGovernanceAudit(capabilities: {
  readonly isPaidPlan: boolean
  readonly canUseUsageExport: boolean
  readonly hostedMaxInFlight: number
}): boolean {
  return capabilities.isPaidPlan && capabilities.canUseUsageExport && capabilities.hostedMaxInFlight > 0
}

export function isAttentionEvent(event: { readonly tier: 'attention' | 'background' | 'result' }): boolean {
  return event.tier === 'attention'
}

export function isForegroundEvent(event: { readonly tier: 'attention' | 'background' | 'result' }): boolean {
  return event.tier !== 'background'
}

export function isUltrafastServiceTier(serviceTier: string): boolean {
  return serviceTier === 'fast' || serviceTier === 'ultrafast'
}

export function isSponsoredComputeProvider(destination: { readonly provider: string }): boolean {
  return destination.provider === 'cloudflare'
}

const cfg: Record<string, number> = { openai: 5000, anthropic: 8000 }
const allowedTargets = ['openai', 'internal']

export function readCallerTimeout(cfg: Record<string, number>, provider: string): number {
  return cfg[provider] ?? 10_000
}

export function hasLocalTarget(provider: string, dynamicTargets: readonly string[]): boolean {
  const allowedTargets = dynamicTargets
  return allowedTargets.includes(provider)
}

export function getDefaultTimeoutCount(): number {
  return Object.keys(cfg).length + allowedTargets.length
}
