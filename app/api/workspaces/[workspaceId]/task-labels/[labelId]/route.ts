import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson, governanceMutationSession, governanceSession } from '@/lib/governance/http'
import { taskLabelsResponse } from '@/lib/task-labels/http'
import { deleteWorkspaceTaskLabel, readWorkspaceTaskLabels, updateWorkspaceTaskLabel } from '@/lib/task-labels/store'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; labelId: string }> }
const GETBody = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  z.uuid().parse(labelId)
  const view = await readWorkspaceTaskLabels((await governanceSession(request, workspaceId)).user, workspaceId)
  const label = view.labels.find(item => item.id === labelId)
  if (!label) throw new GovernanceError('not_found')
  return { workspaceId, source: view.source, canManage: view.canManage, label }
}))
const PATCHBody = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return updateWorkspaceTaskLabel(session.user, workspaceId, labelId, await governanceJson(request))
}))
const DELETEBody = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return deleteWorkspaceTaskLabel(session.user, workspaceId, labelId)
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string; labelId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/task-labels/[labelId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'public', 'none', { workspaceId: string; labelId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/task-labels/[labelId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => PATCHBody(request, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'public', 'none', { workspaceId: string; labelId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/task-labels/[labelId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => DELETEBody(request, { params: Promise.resolve(params) }),
)
