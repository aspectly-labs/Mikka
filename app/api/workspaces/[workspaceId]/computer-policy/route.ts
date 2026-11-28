import { freshSessionRoute } from '@/lib/fresh-session'
import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { auth, apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { ComputerStore } from '@/lib/computer/store'
import { createComputerPolicyHandler } from '@/lib/computer/policy-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 120
const store = new ComputerStore(pool)
const handle = (session: ApiSession, reverifyOnWrite = false) => createComputerPolicyHandler({
  enabled: () => cloudComputerTasksEnabled(),
  store,
  withMember: async (request, workspaceId, admin, operation) => {
    // Revalidate credentials after body streaming completes so a stalled write cannot outlive revocation.
    const current = reverifyOnWrite && admin
      ? await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
      : session
    if (!current?.user || current.user.id !== session.user.id || !apiWorkspaceAllowed(current, workspaceId)) return null
    try {
      return await workspaceDb.transaction(async tx => {
        const { membership } = await requireWorkspace(tx, workspaceId, current.user.id, admin, current.user[enterprisePrincipal])
        // Keep the workspace role authoritative through the application database commit.
        return operation(membership.role === 'admin')
      })
    } catch (error) {
      if (error instanceof WorkspaceError) return null
      throw error
    }
  },
})

export const GET = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
  },
  async ({ request, session, params }) => handle(session)(request, params.workspaceId),
)

const POSTBody = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
    freshSession: true,
  },
  async ({ request, session, params }) => handle(session, true)(request, params.workspaceId),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
