import { freshSessionRoute } from '@/lib/fresh-session'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { WorkspaceError } from '@/lib/workspace-access'
import { auditRetentionInput, configureAuditRetention, readAuditRetention } from '@/lib/audit/retention'
import { defineRoute } from '@/lib/primitives/define-route'
type Context = { params: Promise<{ workspaceId: string }> }
const headers = { 'cache-control': 'private, no-store' }
async function access(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !session.session) return { response: Response.json({ error: 'authRequired' }, { status: 401, headers }) }
  const { workspaceId } = await context.params
  if (!z.uuid().safeParse(workspaceId).success) return { response: new Response(null, { status: 404, headers }) }
  return { actorId: session.user.id, workspaceId }
}
async function GETBody(request: Request, context: Context) {
  const identity = await access(request, context)
  if (identity.response) return identity.response
  try { return Response.json(await readAuditRetention(identity.actorId!, identity.workspaceId!), { headers }) }
  catch (error) {
    if (error instanceof WorkspaceError) return new Response(null, { status: 404, headers })
    return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers })
  }
}
async function PUTHandler(request: Request, context: Context) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403, headers })
  const identity = await access(request, context)
  if (identity.response) return identity.response
  const input = auditRetentionInput.safeParse(await request.json().catch(() => null))
  if (!input.success) return Response.json({ error: 'invalidAuditRetention' }, { status: 400, headers })
  try { return Response.json(await configureAuditRetention(identity.actorId!, identity.workspaceId!, input.data), { headers }) }
  catch (error) {
    if (error instanceof WorkspaceError) return new Response(null, { status: 404, headers })
    return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers })
  }
}

export const GET = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/audit-log/retention',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => z.uuid().safeParse(params.workspaceId).success ? params.workspaceId : undefined,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
const PUTBody = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/audit-log/retention',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => z.uuid().safeParse(params.workspaceId).success ? params.workspaceId : undefined,
    freshSession: true,
  },
  ({ request, params }) => PUTHandler(request, { params: Promise.resolve(params) }),
)

export const PUT = freshSessionRoute(PUTBody)
