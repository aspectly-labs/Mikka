import { z } from 'zod'
import { intersectNetworkDomains } from '@mikka/protocol/agent-policy'
import { cliPolicyLayerSchema } from '@/lib/agent-tool-approval/policy-store'

const externalPolicySchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.enum(['allow', 'ask', 'deny']))

/**
 * Fold stored external-write layers into the workspace's restrictive values.
 * Only deny is folded: copying an allow would grant it to every Bot in the
 * workspace, and there is no ask (ADR 2026-11-27-1615; an old ask reads as
 * allow). github_pull_request is retired with its route.
 */
export function foldExternalWritePermissions(sources: readonly unknown[]): Record<string, 'deny'> {
  const folded: Record<string, 'deny'> = {}
  for (const source of sources) {
    const parsed = externalPolicySchema.parse(source ?? {})
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== 'deny' || key === 'github_pull_request') continue
      folded[key] = 'deny'
    }
  }
  return folded
}

/**
 * Fold stored CLI layers into one restrictive workspace layer. Permissions take
 * the strictest decision, network allow-lists intersect, read_only wins.
 * Workspace defaults are not a source here and are preserved by applyCliFold.
 */
export function foldCliRunPolicy(sources: readonly unknown[]): z.infer<typeof cliPolicyLayerSchema> {
  const permissions: Record<string, 'ask' | 'deny'> = {}
  let networkAllow: string[] | undefined
  let readOnly = false
  for (const source of sources) {
    const layer = cliPolicyLayerSchema.parse(source ?? {})
    for (const [action, decision] of Object.entries(layer.permissions ?? {})) {
      if (decision === 'allow') continue
      if (action === 'git_push' && decision === 'ask') continue
      if (decision === 'deny') permissions[action] = 'deny'
      else if (permissions[action] !== 'deny') permissions[action] = 'ask'
    }
    if (layer.networkAllow !== undefined) networkAllow = networkAllow === undefined ? [...layer.networkAllow] : intersectNetworkDomains(networkAllow, layer.networkAllow)
    if (layer.approvalMode === 'read_only') readOnly = true
  }
  return {
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(networkAllow !== undefined ? { networkAllow } : {}),
    ...(readOnly ? { approvalMode: 'read_only' as const } : {}),
  }
}

/** Merge a CLI fold into the workspace's stored layer, keeping its defaults. */
export function applyCliFold(workspacePolicy: unknown, folded: z.infer<typeof cliPolicyLayerSchema>): z.infer<typeof cliPolicyLayerSchema> {
  const current = cliPolicyLayerSchema.parse(workspacePolicy ?? {})
  return {
    ...current,
    ...(folded.permissions ? { permissions: { ...current.permissions, ...folded.permissions } } : {}),
    ...(folded.networkAllow !== undefined ? { networkAllow: folded.networkAllow } : {}),
    ...(folded.approvalMode ? { approvalMode: folded.approvalMode } : {}),
  }
}

/** Merge an external fold over the workspace's current choices. A stored ask
 * from before ADR 2026-11-27-1615 is written back as allow. */
export function applyExternalFold(workspacePolicy: unknown, folded: Record<string, 'deny'>): Record<string, 'allow' | 'deny'> {
  const current = externalPolicySchema.parse(workspacePolicy ?? {})
  const merged: Record<string, 'allow' | 'deny'> = {}
  for (const [key, value] of Object.entries(current)) merged[key] = value === 'deny' ? 'deny' : 'allow'
  return { ...merged, ...folded }
}
