import { chatBotId } from '@/lib/coordinator/coordinator-bot'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { coordinatorSessions, linearConnections, users } from '@/lib/db/schema'
import { getComposio } from '@/lib/composio'
import { isComposioToolkitSlug } from '@/lib/composio-accounts'
import { listComposioPages } from '@/lib/composio-pagination'
import { readPreferences } from '@/lib/preferences'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { isWorkspaceBoundToOrganization, listOrganizations } from '@/lib/governance/organizations'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { isCloudEdition } from '@/lib/edition'
import { pairedMobileCloudUI } from '@/lib/mobile-web-scope'
import { mobileMembersPage } from '@/lib/mobile-web-target'
import { mobilePluginConnections } from '@/lib/mobile-plugin-connections'
import { json, unauthorized } from '@/lib/mobile-api'
import { defineRoute } from '@/lib/primitives/define-route'


/** Which apps the person connected: every Composio toolkit with an active account (Composio's live list), and Linear. Connecting happens on the web. */
async function connectedApps(userId: string): Promise<{ app: string; connected: boolean; account: string | null }[]> {
  const composio = getComposio()
  const composioAccounts = composio
    ? await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor })).catch(() => [])
    : []
  const active = [...new Set(composioAccounts.filter(account => isComposioToolkitSlug(account.toolkit.slug) && account.status === 'ACTIVE').map(account => account.toolkit.slug))].sort()
  const [linear] = await db.select({ organizationName: linearConnections.organizationName }).from(linearConnections)
    .where(and(eq(linearConnections.userId, userId), isNull(linearConnections.revokedAt))).limit(1)
  return [
    ...active.map(app => ({ app, connected: true, account: null })),
    { app: 'linear', connected: Boolean(linear), account: linear?.organizationName ?? null },
  ]
}

/**
 * `GET /api/mobile/settings`: everything the app's Settings pages show
 * (docs/design/mobile.md, "Settings"): profile, workspaces, 通知 and 记忆
 * settings, the Coordinator's memory as Markdown, and connected apps.
 */
export const GET = defineRoute(
  {
    route: '/api/mobile/settings',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, user }) => {
    const view = new URL(request.url).searchParams.get('view')
    if (view === 'pluginConnections') return json(await mobilePluginConnections(user.id, request.headers))
    // 记忆 is the memory of the Coordinator of the workspace the app has open.
    const context = await loadWorkspaceContext(undefined, user)
    const coordinator = await chatBotId(user.id, null, context.workspace.id)
    const pairedHumanSession = pairedMobileCloudUI() && user[enterprisePrincipal]?.kind === 'session'
    const [preferences, [profile], apps, organizationBound] = await Promise.all([
      readPreferences(user.id),
      db.select({ id: users.id, name: users.name, email: users.email, image: users.image, memory: coordinatorSessions.memory })
        .from(users)
        .leftJoin(coordinatorSessions, and(eq(coordinatorSessions.userId, users.id), eq(coordinatorSessions.botId, coordinator)))
        .where(eq(users.id, user.id)).limit(1),
      view === 'profile' ? [] : connectedApps(user.id),
      pairedHumanSession ? isWorkspaceBoundToOrganization(context.workspace.id) : false,
    ])
    if (!profile) return unauthorized()
    const organization = context.role === 'admin' ? null : (await listOrganizations(user.id)).find(item => item.role === 'owner' || item.role === 'admin')
    return json({
      personalFilesAvailable: pairedHumanSession,
      organizationSettingsAvailable: pairedHumanSession && organizationBound,
      billingScope: context.role === 'admin' ? { kind: 'workspace', id: context.workspace.id } : organization ? { kind: 'organization', id: organization.id } : null,
      user: { id: profile.id, name: profile.name, email: profile.email, image: profile.image },
      workspace: {
        ...context.workspace,
        ...(isCloudEdition() && user[enterprisePrincipal]?.kind === 'session' && context.workspace.kind === 'team' && context.role === 'admin' && {
          serviceIdentityManagementPath: `${mobileMembersPage}?workspace=${context.workspace.id}`,
        }),
      },
      workspaces: context.choices,
      preferences,
      // The session's updatedAt moves with every turn, so the memory carries no 更新于 time.
      memory: profile.memory ?? '',
      apps,
    })
  },
)
