// Negative fixture for no-hardcoded-business-policy: compliant code using runtime config, capabilities, and technical limits.

export interface ActiveOfferConfig {
  readonly enabled: boolean
  readonly trialDays: number
  readonly discountPercent: number
  readonly offerEndAt: string | null
}

export interface WorkspaceCapabilitiesView {
  readonly approvalTemplateLimit: number
  readonly hostedMaxInFlight: number
}

export const MAX_RETRY_ATTEMPTS = 3
export const REQUEST_TIMEOUT_MS = 30_000
export const MAX_FREE_MEMORY = 1024

export const httpAgentPoolOptions = {
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 64,
}

export function resolveActiveOffer(config: ActiveOfferConfig) {
  return {
    trialDays: config.trialDays,
    discountPercent: config.discountPercent,
    offerEndAt: config.offerEndAt,
  }
}

export function canCreateApprovalTemplate(
  capabilities: WorkspaceCapabilitiesView,
  currentCount: number,
): boolean {
  return currentCount < capabilities.approvalTemplateLimit
}
