import { z } from 'zod'
import { json, mobileUser } from '@/lib/mobile-api'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { workspaceSelection } from '@/lib/workspace-selection'
import { mobileTask } from '@/lib/mobile-tasks'
import { editMobileTask, mobileTaskOptions } from '@/lib/mobile-task-edit'
import { mobileTaskEditInput, mobileTaskWriteError } from '@/lib/mobile-task-edit-contract'
import { ActionFailureError } from '@/lib/action-error'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

type MobileUser = NonNullable<Awaited<ReturnType<typeof mobileUser>>>

/** The app's selected workspace, when it sent one: the task must be in it. */
async function selectedWorkspace(request: Request, user: MobileUser) {
  return workspaceSelection(request.headers).present ? (await loadWorkspaceContext(undefined, user)).workspace.id : undefined
}

/** A missing, hidden or no longer reachable task, however the check failed. */
const hidden = (error: unknown) => error instanceof WorkspaceError
  || (error instanceof ActionFailureError && ['issueNotFound', 'workspaceAccessDenied'].includes(error.code))

/**
 * Read one task and its attempts; raw run errors remain on /api/mobile/threads/:id.
 * `?options=1` adds `options`: the status, priority and assignee pickers' choices and `canEdit`.
 */
async function handleGET(request: Request, user: ApiSession['user'], { params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'issueNotFound' }, 404)
  try {
    const selectedWorkspaceId = await selectedWorkspace(request, user)
    const search = new URL(request.url).searchParams
    const detail = await mobileTask(user, id.data, selectedWorkspaceId, search.get('work') === '1')
    if (!detail) return json({ error: 'issueNotFound' }, 404)
    if (search.get('options') !== '1') return json(detail)
    const options = await mobileTaskOptions(user, id.data, selectedWorkspaceId)
    return options ? json({ ...detail, options }) : json({ error: 'issueNotFound' }, 404)
  } catch (error) {
    if (hidden(error)) return json({ error: 'issueNotFound' }, 404)
    throw error
  }
}

/**
 * `PATCH /api/mobile/tasks/:id` with `{ revision, status?, stateId?, priority?, assigneeId? }`:
 * the web's own status, priority and assignee changes. Answers the task as GET does;
 * 409 `issueStale` when `revision` is not the task's, 404 when the person may not edit it.
 */
async function handlePATCH(request: Request, user: ApiSession['user'], { params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'issueNotFound' }, 404)
  const input = mobileTaskEditInput.safeParse(await request.json().catch(() => null))
  if (!input.success) return json({ error: 'validationGeneric' }, 400)
  try {
    const result = await editMobileTask(user, id.data, input.data, await selectedWorkspace(request, user))
    if ('detail' in result) return json(result.detail)
    const { status, error } = mobileTaskWriteError(result.error)
    return json({ error }, status)
  } catch (error) {
    if (hidden(error)) return json({ error: 'issueNotFound' }, 404)
    throw error
  }
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/tasks/[id]',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
    onWorkspaceError: () => json({ error: 'issueNotFound' }, 404),
  },
  async ({ request, user, params }) => handleGET(request, user, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/tasks/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
    onWorkspaceError: () => json({ error: 'issueNotFound' }, 404),
  },
  async ({ request, user, params }) => handlePATCH(request, user, { params: Promise.resolve(params) }),
)
