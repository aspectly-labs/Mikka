import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { json } from '@/lib/mobile-api'
import { runOutsideToken } from '@/lib/tokens/scope'
import { actAs } from '@/lib/acting-user'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


type Params = { params: Promise<{ id: string }> }

/**
 * `POST /api/mobile/threads/:id/continue` with `{ via: 'key' | 'retry' }`: a run
 * paused on its subscription's quota goes on, as the web's quota card does
 * (lib/run-quota.ts): on the person's API key, or with its original credential
 * after the reset. `:id` is the paused run (`paused.runId` of the thread).
 */
async function handlePOST(request: Request, user: ApiSession['user'], { params }: Params) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'runNotFound' }, 404)
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId) return json({ error: 'runNotFound' }, 404)
  // Resolve once and retain the verified session/PAT proof through the quota
  // transaction. The body and a later cookie change cannot select its tenant.
  const reader = { ...user, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: user[enterprisePrincipal] }
  if (await runOutsideToken(reader, id.data)) return json({ error: 'runNotFound' }, 404)
  const body = z.object({ via: z.enum(['key', 'retry']) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidRequest' }, 400)
  const quota = await import('@/lib/run-quota')
  try {
    return json(await actAs(reader, () => (body.data.via === 'key' ? quota.resumeQuotaPausedRunOnApiKey : quota.retryQuotaPausedRun)(user.id, id.data)))
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, ['runNotFound', 'workspaceAccessDenied'].includes(error.code) ? 404 : 409)
    throw error
  }
}

export const POST = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/threads/[id]/continue',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user, params }) => handlePOST(request, user, { params: Promise.resolve(params) }),
)
