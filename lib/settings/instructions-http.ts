import 'server-only'
import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-access'

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' }

export function instructionStatusForCode(code: string | undefined): number {
  if (!code) return 200
  if (code === 'authRequired' || code === 'SESSION_NOT_FRESH') return 401
  if (code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended' || code === 'invalidOrigin') return 403
  if (code === 'botNotFound' || code === 'projectEnvironmentUnavailable' || code === 'projectNotFound') return 404
  if (code === 'projectArchived' || code === 'projectResourceConflict') return 409
  return 400
}

export function instructionJson(body: unknown, status = 200) {
  return RouteResponse.json(body, { status, headers: PRIVATE_HEADERS })
}

export function validSameOriginWrite(request: Request): boolean {
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

export async function runInstructionRoute(request: Request, work: () => Promise<unknown>) {
  if (request.method !== 'GET' && !validSameOriginWrite(request)) {
    return instructionJson({ error: 'invalidOrigin' }, 403)
  }
  try {
    const result = await work()
    const code = result && typeof result === 'object' && 'error' in result && typeof (result as { error?: unknown }).error === 'string'
      ? (result as { error: string }).error
      : undefined
    return instructionJson(result, instructionStatusForCode(code))
  } catch (error) {
    if (error instanceof ActionFailureError || error instanceof WorkspaceError) {
      return instructionJson({ error: error.code }, instructionStatusForCode(error.code))
    }
    if (error instanceof z.ZodError) {
      return instructionJson({ error: 'validationGeneric' }, 400)
    }
    throw error
  }
}
