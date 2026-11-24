import { z } from 'zod'
import { afterJob } from '@/lib/background'
import { ActionFailureError } from '@/lib/action-error'
import { startSuggestion } from '@/lib/cloud-computer/suggestions'
import { ComputerError } from '@/lib/computer/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { pool } from '@/lib/db'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { handoffSuggestionToCoordinator } from '@/lib/suggestions/handoff'
import { dismissSuggestion } from '@/lib/suggestions/store'
import { suggestionsOutsideToken } from '@/lib/tokens/scope'
import { loadWorkspaceContext } from '@/lib/workspace-access'

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
async function handlePOST(request: Request, { params }: Params) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()

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
    const context = await loadWorkspaceContext(undefined, user)
    const result = await startSuggestion(
      pool,
      { userId: user.id, workspaceId: context.workspace.id },
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
    throw error
  }
}

/**
 * `DELETE /api/mobile/suggestions/:id`: dismisses one suggestion from the
 * person's proactive list using the mobile origin policy (`writeAllowed`).
 */
async function handleDELETE(request: Request, { params }: Params) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()

  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'invalidSuggestion' }, 400)

  if ((await suggestionsOutsideToken(user, [id.data])).size) {
    return json({ error: 'suggestionNotFound' }, 404)
  }

  return (await dismissSuggestion(user.id, id.data))
    ? json({ dismissed: true })
    : json({ error: 'suggestionNotFound' }, 404)
}

export const POST = withRequestLog('/api/mobile/suggestions/[id]', handlePOST)
export const DELETE = withRequestLog('/api/mobile/suggestions/[id]', handleDELETE)
