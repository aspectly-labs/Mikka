import 'server-only'
import { z } from 'zod'
import { auth, type ApiSession } from '@/lib/api-auth'
import { desktopSameOriginRequest } from '@/lib/desktop-auth'
import { ActionFailureError } from '@/lib/action-error'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson } from '@/lib/governance/http'
import { WorkspaceError } from '@/lib/workspace-access'
import { isActionErrorCode } from '@/lib/workspace-admin/action'

const NO_STORE_HEADERS = { 'cache-control': 'private, no-store' } as const

export async function requireDeviceApiSession(
  request: Request,
  mutation = false,
  authenticatedSession?: ApiSession,
): Promise<ApiSession> {
  const session = authenticatedSession ?? await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) throw new ActionFailureError('authRequired')
  if (mutation) {
    if (!desktopSameOriginRequest(request)) throw new WorkspaceError('workspaceAccessDenied')
    if (!session.tokenId && request.headers.has('cookie') && !request.headers.has('origin')) {
      throw new WorkspaceError('workspaceAccessDenied')
    }
  }
  return session
}

export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  if (!request.body && !request.headers.get('content-length')) return null
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.startsWith('application/json')) throw new GovernanceError('invalid_request')
  return governanceJson(request)
}

export async function readRequiredJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new GovernanceError('invalid_request')
  }
  return governanceJson(request)
}

export async function wsGJsonResponse(work: () => Promise<Response | unknown>): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE_HEADERS })
  try {
    const value = await work()
    return value instanceof Response ? value : json(value)
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'validationGeneric' }, 400)
    if (error instanceof GovernanceError) {
      if (error.detail === 'access_denied') return json({ error: 'workspaceAccessDenied' }, 403)
      if (error.detail === 'not_found') return json({ error: 'deviceNotFound' }, 404)
      if (error.detail === 'invalid_request') return json({ error: 'validationGeneric' }, 400)
      return json({ error: 'generic' }, 409)
    }
    if (error instanceof ActionFailureError) {
      const code = error.code
      if (code === 'authRequired') return json({ error: code }, 401)
      if (code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended') return json({ error: code }, 403)
      if (code === 'deviceNotFound' || code === 'repoNotFound') return json({ error: code }, 404)
      if (code === 'repoPathInvalid' || code === 'agentInvalidInput' || code === 'validationGeneric') return json({ error: code }, 400)
      return json({ error: code }, 409)
    }
    if (error instanceof WorkspaceError) {
      const code = isActionErrorCode(error.code) ? error.code : 'generic'
      if (error.code === 'workspaceAccessDenied') return json({ error: 'workspaceAccessDenied' }, 403)
      if (error.code === 'billingAutoRechargeUnavailable') {
        return json({
          error: 'billingAutoRechargeUnavailable',
          state: 'provider_unsupported',
          provider: 'stripe_managed_payments',
        }, 409)
      }
      return json({ error: code }, 409)
    }
    console.error('wsg_request_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
    return json({ error: 'generic' }, 500)
  }
}
