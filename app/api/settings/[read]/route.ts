import { RouteResponse } from '@/lib/server-runtime/server'
import type { ApiSession } from '@/lib/api-auth'
import { defineRoute, isPatSession } from '@/lib/primitives/define-route'
import { selectedWorkspaceId } from '@/lib/workspace-selection'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { singleFlight } from '@/lib/single-flight'
import { getPasswordStatus, listSessions } from '@/app/actions/account'
import { getPreferences } from '@/app/actions/preferences'
import { getIssuePrefixState } from '@/app/actions/issue-prefix'
import { cacheReadAction } from '@/lib/cache-read-action'
import { listActivity, listSavedLogins } from '@/app/actions/settings-activity'
import { getWorkspaceDeletionImpact, getWorkspaceGeneral, getWorkspaceTransferTargets } from '@/app/actions/workspace-settings'
import { getAppPolicy } from '@/app/actions/app-policy'
import { getCreditShare, getPaymentDesignation, getSharePolicy } from '@/app/actions/personal-policy'
import { getE2BKeyCapability, listSecrets } from '@/app/actions/workspace-secrets'
import { getUsage } from '@/app/actions/usage'
import { cardVerificationStatus, getBilling, getCreditBilling } from '@/app/actions/billing'
import { listAuditLog } from '@/app/actions/audit-log'
import { getModelOrder } from '@/app/actions/model-order'
import { listBots, listWorkspaceBots } from '@/app/actions/bots'
import { getApiKeys } from '@/app/actions/model-api-keys'
import { listEnvironments } from '@/app/actions/environments'
import { getThreadTitleSettings } from '@/app/actions/thread-title-settings'
import { getIssueStates } from '@/app/actions/issue-states'
import { auditScopeQuery } from '@/lib/audit/cursor'
import type { SettingsRead } from '@/lib/settings-read'

/**
 * Settings' first reads as GETs. They call the same functions the sections
 * used to call as server actions, with the same session and workspace/admin
 * checks inside, and return the same bodies. A GET never waits in Next's
 * one-at-a-time server-action queue, so reading never delays a save.
 */
const READS: Record<SettingsRead, (query: URLSearchParams) => Promise<unknown>> = {
  password: () => getPasswordStatus(),
  sessions: () => listSessions(),
  preferences: () => getPreferences(),
  'issue-prefix': () => getIssuePrefixState(),
  'saved-logins': () => listSavedLogins(),
  activity: query => listActivity({ filter: (query.get('filter') ?? undefined) as NonNullable<Parameters<typeof listActivity>[0]>['filter'], cursor: query.get('cursor') }),
  'workspace-general': query => getWorkspaceGeneral(workspace(query)),
  'transfer-targets': query => getWorkspaceTransferTargets(workspace(query)),
  'deletion-impact': query => getWorkspaceDeletionImpact(workspace(query)),
  'app-policy': query => getAppPolicy(workspace(query)),
  'share-policy': query => getSharePolicy(workspace(query)),
  // 团队工作区专属 (#838, 决定 2310): 个人工作区视图里这两项不出现，函数返回成员视角的空值。
  'payment-designation': query => getPaymentDesignation(workspace(query)),
  'credit-share': query => getCreditShare(workspace(query)),
  secrets: query => listSecrets(workspace(query)),
  // The E2B row needs canEdit as well as the key's state.
  'e2b-key': query => getE2BKeyCapability(workspace(query)),
  usage: query => getUsage(query.get('month') ?? undefined, workspace(query)),
  billing: query => getBilling(workspace(query)),
  'credit-billing': query => getCreditBilling(workspace(query)),
  'card-verification': query => cardVerificationStatus(workspace(query)),
  // listWorkspaceAudit validates the filter and cursor.
  // 模型与订阅: the allowed models in order and 运行位置 (decision 2026-11-02-1400).
  'model-order': query => getModelOrder(workspace(query)),
  bots: query => listBots(workspace(query)),
  'workspace-bots': query => listWorkspaceBots(workspace(query)),
  'api-keys': query => getApiKeys(workspace(query)),
  environments: query => listEnvironments(workspace(query)),
  // The workspace's task states (decision 2026-11-19-2115): the settings page, the board and every status picker.
  'issue-states': query => getIssueStates(workspace(query)),
  // Capy's "Thread titles": the workspace's and the reader's own naming settings.
  'thread-titles': query => getThreadTitleSettings(workspace(query)),
  audit: query => listAuditLog({ ...auditScopeQuery(query), cursor: query.get('cursor') } as Parameters<typeof listAuditLog>[0], workspace(query)),
}

/**
 * Each request is authorized on its own: its session and, for a workspace read,
 * its membership and role in that workspace (a removed member resolves elsewhere
 * or is refused). Identical concurrent reads with the same authorization share
 * one read, which still runs its own checks. Any failure here reads unshared.
 */
async function shareKey(read: string, query: URLSearchParams, session: ApiSession) {
  // The same account's devices mark different sessions as current. This read
  // has request/session-specific output, not just an account/workspace input.
  // Workspace-scoped PATs never join an owner's in-flight human session read.
  if (read === 'sessions' || isPatSession(session)) return null
  try {
    const { user } = session
    const normalizedQuery = normalizedSearchKey(read, query)
    if (ACCOUNT_READS.has(read)) return ['/api/settings', read, user.id, normalizedQuery]
    const { loadWorkspaceContext } = await import('@/lib/workspace-access')
    const context = await loadWorkspaceContext(workspace(query), user)
    return ['/api/settings', read, user.id, context.workspace.id, context.role, normalizedQuery]
  } catch { return null }
}

/** Reads of the signed-in account alone, with no workspace input. */
const ACCOUNT_READS = new Set<string>(['password', 'preferences', 'issue-prefix', 'saved-logins', 'activity'])

function workspace(query: URLSearchParams) {
  const raw = query.get('workspace')
  if (!raw) return undefined
  return selectedWorkspaceId(raw) ?? undefined
}

function normalizedSearchKey(read: string, query: URLSearchParams) {
  if (ACCOUNT_READS.has(read) || !query.has('workspace')) return query.toString()
  const normalized = new URLSearchParams(query)
  const id = workspace(query)
  if (id) normalized.set('workspace', id)
  else normalized.delete('workspace')
  return normalized.toString()
}

export const GET = defineRoute<'session', 'pat-scoped', { read: string }>(
  {
    route: '/api/settings/[read]',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ request, params }) =>
      !Object.hasOwn(READS, params.read) || ACCOUNT_READS.has(params.read) || params.read === 'sessions'
        ? undefined
        : new URL(request.url).searchParams.get('workspace'),
  },
  async ({ request, params, session }) => {
    const { read } = params
    if (!Object.hasOwn(READS, read)) return RouteResponse.json({ error: 'notFound' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
    const body = await cacheReadAction(() => withDatabaseOperation(`/api/settings/${read}`, async () => {
      const query = new URL(request.url).searchParams
      const run = () => READS[read as SettingsRead](query)
      const key = await shareKey(read, query, session)
      return key ? singleFlight(key, run) : run()
    }))
    const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined
    const status = code === 'authRequired' ? 401 : code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended' ? 403 : 200
    return RouteResponse.json(body ?? null, { status, headers: { 'Cache-Control': 'private, no-store' } })
  },
)
