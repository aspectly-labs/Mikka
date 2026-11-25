import { z } from 'zod'
import { json } from '@/lib/mobile-api'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { workspaceSelection } from '@/lib/workspace-selection'
import { postMobileTaskComment } from '@/lib/mobile-task-edit'
import { mobileTaskCommentInput, mobileTaskWriteError } from '@/lib/mobile-task-edit-contract'
import { ActionFailureError } from '@/lib/action-error'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

/**
 * `POST /api/mobile/tasks/:id/comments` with `{ body, clientId? }`: a comment on
 * the task, as the web's discussion writes it. Answers 201 with the task as GET
 * /api/mobile/tasks/:id does, plus `comment`, the new row of its `timeline`.
 */
async function handlePOST(request: Request, user: ApiSession['user'], { params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'issueNotFound' }, 404)
  const input = mobileTaskCommentInput.safeParse(await request.json().catch(() => null))
  if (!input.success) return json({ error: 'validationGeneric' }, 400)
  try {
    const selectedWorkspaceId = workspaceSelection(request.headers).present
      ? (await loadWorkspaceContext(undefined, user)).workspace.id : undefined
    const result = await postMobileTaskComment(user, id.data, input.data, selectedWorkspaceId)
    if ('detail' in result) return json({ ...result.detail, comment: result.comment }, 201)
    const { status, error } = mobileTaskWriteError(result.error)
    return json({ error }, status)
  } catch (error) {
    if (error instanceof WorkspaceError || (error instanceof ActionFailureError && ['issueNotFound', 'workspaceAccessDenied'].includes(error.code)))
      return json({ error: 'issueNotFound' }, 404)
    throw error
  }
}

export const POST = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/tasks/[id]/comments',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
    onWorkspaceError: () => json({ error: 'issueNotFound' }, 404),
  },
  async ({ request, user, params }) => handlePOST(request, user, { params: Promise.resolve(params) }),
)
