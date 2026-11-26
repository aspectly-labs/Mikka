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
