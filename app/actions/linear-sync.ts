'use server'
import { requireUser } from '@/lib/issue-access'
import { cookies } from '@/lib/server-runtime/headers'
import { createLinearAuthorizationUrl, disconnectLinear, stateCookieOptions, LINEAR_OAUTH_STATE_COOKIE } from '@/lib/linear-sync/oauth'
import { runAction } from '@/lib/action-error'

// Older desktop clients still call these RPCs.
export async function getLinearIntegrationState(_workspaceId?: string) {
  return { workspaceId: null, enabled: false, configured: false, connected: false, organizationName: null, syncs: [], errors: [], inboundErrors: [] }
}

export async function getLinearBoardSync(_workspaceId?: string) {
  return runAction(async () => ({ synced: false }))
}

export async function startLinearOAuth() {
  const user = await requireUser()
  const authorization = await createLinearAuthorizationUrl(user.id)
  ;(await cookies()).set(LINEAR_OAUTH_STATE_COOKIE, authorization.state, stateCookieOptions(600))
  return { url: authorization.url }
}

export async function listLinearTeamOptions() {
  return []
}

export async function enableLinearTeam(_input: { teamId: string; workspaceId?: string }) {
  return { error: 'linearSyncDisabled' as const }
}

export async function disableLinearTeam(_id: string, _workspaceId?: string) {
  return { error: 'linearSyncDisabled' as const }
}

export async function retryLinearIssue(_issueId: string) {
  return { error: 'linearSyncDisabled' as const }
}

export async function retryLinearDelivery(_deliveryId: string) {
  return { error: 'linearSyncDisabled' as const }
}

export async function disconnectLinearAccount() {
  const user = await requireUser()
  await disconnectLinear(user.id)
  return { success: true as const }
}
