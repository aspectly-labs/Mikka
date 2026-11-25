import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { json } from '@/lib/mobile-api'
import { decidePendingAction } from '@/lib/pending-actions'
import { pendingActionsOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


type Params = { params: Promise<{ id: string }> }

/**
 * `POST /api/mobile/pending-actions/:id` with `{ approve }`: the person
 * approves (runs) or declines one proposal from the app, as the web's
 * decidePendingAction server action does. The list is `/api/pending-actions`.
 * 409 when it was already decided or has expired.
 */
async function handlePOST(request: Request, user: ApiSession['user'], { params }: Params) {
  const id = z.uuid().safeParse((await params).id)
  const body = z.object({ approve: z.boolean() }).safeParse(await request.json().catch(() => null))
  if (!id.success || (await pendingActionsOutsideToken(user, [id.data])).size) return json({ error: 'pendingActionUnavailable' }, 409)
  if (!body.success) return json({ error: 'invalidInput' }, 400)
  try {
    const { status, error } = await decidePendingAction(user.id, id.data, body.data.approve)
    return json({ status, reason: error })
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 409)
    throw error
  }
}

export const POST = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/pending-actions/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user, params }) => handlePOST(request, user, { params: Promise.resolve(params) }),
)
