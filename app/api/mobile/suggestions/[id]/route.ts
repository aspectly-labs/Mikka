import { z } from 'zod'
import { afterJob } from '@/lib/background'
import { ActionFailureError } from '@/lib/action-error'
import { resolveSuggestionStartWorkspace, startSuggestion } from '@/lib/cloud-computer/suggestions'
import { ComputerError } from '@/lib/computer/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { pool } from '@/lib/db'
import { json } from '@/lib/mobile-api'
import { handoffSuggestionToCoordinator } from '@/lib/suggestions/handoff'
import { dismissSuggestion } from '@/lib/suggestions/store'
import { suggestionsOutsideToken } from '@/lib/tokens/scope'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

type Params = { params: Promise<{ id: string }> }

const postBody = z.object({ action: z.enum(['send', 'start']) }).strict()

/**
 * `POST /api/mobile/suggestions/:id` with `{ action: 'send' | 'start' }`:
 * - `'send'`: hands the suggestion off to the person's Coordinator chat
 *   (same owning writer as `app/actions/coordinator.ts:sendSuggestion`).
 * - `'start'`: starts the suggestion directly on the Bot's cloud computer
 *   (same owning writer as `POST /api/suggestions/:id/start`), using the
 *   mobile origin policy (`writeAllowed`).
 */
async function handlePOST(request: Request, user: ApiSession['user'], { params }: Params) {

  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'invalidSuggestion' }, 400)

  const parsed = postBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalidInput' }, 400)

  if ((await suggestionsOutsideToken(user, [id.data])).size) {
    return json({ error: 'suggestionNotFound' }, 404)
  }

  try {
    if (parsed.data.action === 'send') {
      return json(await handoffSuggestionToCoordinator(user.id, id.data), 202)
    }
    const workspaceId =
      (await resolveSuggestionStartWorkspace(pool, user, id.data))
      ?? (await loadWorkspaceContext(undefined, user)).workspace.id
    const result = await startSuggestion(
      pool,
      { userId: user.id, workspaceId },
      id.data,
    )
    afterJob('after:coordinator-wake', () => wakeCoordinator(user.id))
    return json(result, 202)
  } catch (error) {
    if (error instanceof ActionFailureError) {
      const status =
        error.code === 'suggestionNotFound'
          ? 404
          : error.code === 'submissionConflict'
            ? 409
            : error.code === 'coordinatorUnavailable'
              ? 503
              : 400
      return json({ error: error.code }, status)
    }
    if (error instanceof ComputerError) return json({ error: error.message }, error.status)
    if (error instanceof WorkspaceError) {
      return json(
        { error: error.code === 'workspaceAccessDenied' ? 'workspaceAccessDenied' : error.code },
        error.code === 'workspaceAccessDenied' ? 403 : 409,
      )
    }
    throw error
  }
}

/**
 * `DELETE /api/mobile/suggestions/:id`: dismisses one suggestion from the
 * person's proactive list using the mobile origin policy (`writeAllowed`).
 */
async function handleDELETE(request: Request, user: ApiSession['user'], { params }: Params) {

  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'invalidSuggestion' }, 400)

  if ((await suggestionsOutsideToken(user, [id.data])).size) {
    return json({ error: 'suggestionNotFound' }, 404)
  }

  return (await dismissSuggestion(user.id, id.data))
    ? json({ dismissed: true })
    : json({ error: 'suggestionNotFound' }, 404)
}

export const POST = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/suggestions/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user, params }) => handlePOST(request, user, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/suggestions/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user, params }) => handleDELETE(request, user, { params: Promise.resolve(params) }),
)
