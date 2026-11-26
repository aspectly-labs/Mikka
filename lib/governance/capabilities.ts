/**
 * T3 — Declarative Workspace Capabilities.
 *
 * Centralizes plan/edition capability flags and numeric limits into a single
 * Zod-validated contract with explicit ownership metadata so server routes and
 * UI surfaces read semantic capabilities instead of hardcoding tier names or
 * scattered limit constants.
 */
import { z } from 'zod'
import type { PlanEntitlementOverridesPayload } from '@/lib/runtime-config/schema'

export type CapabilityPlan = 'free' | 'pro' | 'enterprise'
export type CapabilityDeploymentMode = 'cloud' | 'selfhost'
export type CapabilityWorkspaceKind = 'personal' | 'team'
export type WorkspaceEdition = 'personal' | 'community' | 'team_free' | 'team_pro' | 'enterprise'

export const workspaceCapabilitiesSchema = z.object({
  isPaidPlan: z.boolean(),
  canUseUsageExport: z.boolean(),
  canUseApprovalTemplates: z.boolean(),
  approvalTemplateLimit: z.number().int().nonnegative(),
  hostedMaxInFlight: z.number().int().positive(),
  canUseEnterpriseGovernance: z.boolean(),
  canUseSso: z.boolean(),
  canUseScim: z.boolean(),
  canUseResourcePolicy: z.boolean(),
  canManageOrgBilling: z.boolean(),
  activeHumanLimit: z.number().int().positive().nullable(),
}).strict()

export type WorkspaceCapabilities = z.infer<typeof workspaceCapabilitiesSchema>

export interface WorkspaceCapabilityOwnerMetadata {
  readonly owner: string
  readonly description: string
}

/** Explicit ownership registry for every WorkspaceCapabilities field (enforced by G6). */
export const WORKSPACE_CAPABILITY_OWNERS: Readonly<
  Record<keyof WorkspaceCapabilities, WorkspaceCapabilityOwnerMetadata>
> = Object.freeze({
  isPaidPlan: {
    owner: 'billing',
    description: 'Whether the workspace currently holds an active paid plan (Pro or Enterprise).',
  },
  canUseUsageExport: {
    owner: 'governance',
    description: 'Whether workspace admins can view daily usage breakdowns and export governance usage reports.',
  },
  canUseApprovalTemplates: {
    owner: 'governance',
    description: 'Whether workspace admins can create, save, and apply governance approval templates.',
  },
  approvalTemplateLimit: {
    owner: 'governance',
    description: 'Maximum number of saved governance approval templates allowed for the workspace.',
  },
  hostedMaxInFlight: {
    owner: 'runtime-quota',
    description: 'Maximum concurrent hosted model calls admitted per workspace.',
  },
  canUseEnterpriseGovernance: {
    owner: 'governance',
    description: 'Whether enterprise-tier organization governance features are enabled for the workspace.',
  },
  canUseSso: {
    owner: 'enterprise-identity',
    description: 'Whether SAML/OIDC enterprise SSO identity provider management is enabled.',
  },
  canUseScim: {
    owner: 'enterprise-identity',
    description: 'Whether enterprise SCIM directory provisioning connections are enabled.',
  },
  canUseResourcePolicy: {
    owner: 'governance',
    description: 'Whether organization-wide resource sharing, provider allowlists, retention, and legal hold policies are enabled.',
  },
  canManageOrgBilling: {
    owner: 'billing',
    description: 'Whether the workspace can participate in Cloud organization billing designation and management.',
  },
  activeHumanLimit: {
    owner: 'workspace-access',
    description: 'Maximum active human members permitted in the workspace scope, or null when unlimited.',
  },
})

export type PlanCapabilityProfile = Readonly<Omit<WorkspaceCapabilities, 'activeHumanLimit'>>

/** Base capability profiles per plan tier for shared workspaces. */
export const PLAN_CAPABILITY_PROFILES: Readonly<Record<CapabilityPlan, PlanCapabilityProfile>> = Object.freeze({
  free: Object.freeze({
    isPaidPlan: false,
    canUseUsageExport: false,
    canUseApprovalTemplates: false,
    approvalTemplateLimit: 0,
    hostedMaxInFlight: 8,
    canUseEnterpriseGovernance: false,
    canUseSso: false,
    canUseScim: false,
    canUseResourcePolicy: false,
    canManageOrgBilling: true,
  }),
  pro: Object.freeze({
    isPaidPlan: true,
    canUseUsageExport: true,
    canUseApprovalTemplates: true,
    approvalTemplateLimit: 100,
    hostedMaxInFlight: 32,
    canUseEnterpriseGovernance: false,
    canUseSso: false,
    canUseScim: false,
    canUseResourcePolicy: false,
    canManageOrgBilling: true,
  }),
  enterprise: Object.freeze({
    isPaidPlan: true,
    canUseUsageExport: true,
    canUseApprovalTemplates: true,
    approvalTemplateLimit: 1000,
    hostedMaxInFlight: 128,
    canUseEnterpriseGovernance: true,
    canUseSso: true,
    canUseScim: true,
    canUseResourcePolicy: true,
    canManageOrgBilling: true,
  }),
})

/** Adjustments applied to self-hosted community (unlicensed free) deployments. */
export const COMMUNITY_CAPABILITY_ADJUSTMENTS: Readonly<Partial<WorkspaceCapabilities>> = Object.freeze({
  canUseUsageExport: true,
  canUseApprovalTemplates: true,
  approvalTemplateLimit: 100,
  canManageOrgBilling: false,
})

/** Adjustments applied to all self-hosted deployments regardless of license tier. */
export const SELFHOST_CAPABILITY_ADJUSTMENTS: Readonly<Partial<WorkspaceCapabilities>> = Object.freeze({
  canManageOrgBilling: false,
})

/** Adjustments applied to personal workspaces (one owner, no organization billing). */
export const PERSONAL_WORKSPACE_CAPABILITY_ADJUSTMENTS: Readonly<Partial<WorkspaceCapabilities>> = Object.freeze({
  activeHumanLimit: 1,
  canManageOrgBilling: false,
})

const TEAM_EDITION_BY_PLAN: Readonly<Record<CapabilityPlan, WorkspaceEdition>> = Object.freeze({
  free: 'team_free',
  pro: 'team_pro',
  enterprise: 'enterprise',
})

/** Resolves the workspace edition label declaratively from plan, deployment mode, and workspace kind. */
export function resolveWorkspaceEdition(input: {
  plan: CapabilityPlan
  mode: CapabilityDeploymentMode
  kind: CapabilityWorkspaceKind
}): WorkspaceEdition {
  if (input.kind === 'personal') return 'personal'
  if (input.mode === 'selfhost' && input.plan === 'free') return 'community'
  return TEAM_EDITION_BY_PLAN[input.plan]
}

export type PlanEntitlementOverrides = PlanEntitlementOverridesPayload

function isOverrideWindowActive(
  overrides: PlanEntitlementOverrides,
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false
  const startMs = overrides.startAt === undefined ? undefined : Date.parse(overrides.startAt)
  const endMs = overrides.endAt === undefined ? undefined : Date.parse(overrides.endAt)
  if (startMs !== undefined && Number.isNaN(startMs)) return false
  if (endMs !== undefined && Number.isNaN(endMs)) return false
  if (startMs !== undefined && endMs !== undefined && startMs >= endMs) return false
  if (startMs !== undefined && nowMs < startMs) return false
  if (endMs !== undefined && nowMs >= endMs) return false
  return true
}

export interface ResolveWorkspaceCapabilitiesInput {
  plan: CapabilityPlan
  mode: CapabilityDeploymentMode
  kind: CapabilityWorkspaceKind
  overrides?: PlanEntitlementOverrides | null
  now?: Date | number
}

/**
 * Resolves the canonical `WorkspaceCapabilities` object from declarative plan
 * profiles, deployment/workspace-kind adjustments, and optional runtime-config
 * entitlement overrides.
 */
export function resolveWorkspaceCapabilities(
  input: ResolveWorkspaceCapabilitiesInput,
): WorkspaceCapabilities {
  const isCommunity = input.mode === 'selfhost' && input.plan === 'free'
  const resolved: WorkspaceCapabilities = {
    ...PLAN_CAPABILITY_PROFILES[input.plan],
    activeHumanLimit: null,
  }

  if (input.mode === 'selfhost') {
    Object.assign(resolved, SELFHOST_CAPABILITY_ADJUSTMENTS)
  }
  if (isCommunity) {
    Object.assign(resolved, COMMUNITY_CAPABILITY_ADJUSTMENTS)
  }
  if (input.kind === 'personal') {
    Object.assign(resolved, PERSONAL_WORKSPACE_CAPABILITY_ADJUSTMENTS)
  }

  if (input.overrides) {
    const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now())
    if (isOverrideWindowActive(input.overrides, nowMs)) {
      const templateBucket = isCommunity ? 'community' : input.plan
      const templateOverride = input.overrides.approvalTemplateLimit?.[templateBucket]
      if (typeof templateOverride === 'number' && Number.isSafeInteger(templateOverride) && templateOverride >= 0) {
        resolved.approvalTemplateLimit = templateOverride
        resolved.canUseApprovalTemplates = templateOverride > 0
      }

      const inFlightOverride = input.overrides.hostedMaxInFlight?.[input.plan]
      if (typeof inFlightOverride === 'number' && Number.isSafeInteger(inFlightOverride) && inFlightOverride > 0) {
        resolved.hostedMaxInFlight = inFlightOverride
      }
    }
  }

  return workspaceCapabilitiesSchema.parse(resolved)
}
