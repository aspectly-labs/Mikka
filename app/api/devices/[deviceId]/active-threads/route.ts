import { z } from 'zod'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { hasPatAuthorizationHeader, isPatSession } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'

const headers = { 'Cache-Control': 'private, no-store' }

export const GET = defineRoute<'session', 'none', { deviceId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    onAuthFailure: () => new Response(null, { status: 401, headers }),
  },
  async ({ request, params, session }) => {
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return new Response(null, { status: 401, headers })
    const { deviceId } = params
    const after = new URL(request.url).searchParams.getAll('after')
    if (!z.uuid().safeParse(deviceId).success || after.length > 1 || after.some(id => !z.uuid().safeParse(id).success)) {
      return new Response(null, { status: 400, headers })
    }
    const reader = { id: session.user.id, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
    const workspaceId = await effectiveRequestWorkspace(reader)
    if (!workspaceId) return new Response(null, { status: 404, headers })
    const [{ activeThreadsOnOwnedDevice }, { pool }] = await Promise.all([import('@/lib/conversation-directory'), import('@/lib/db')])
    const page = await activeThreadsOnOwnedDevice(pool, reader, workspaceId, deviceId, after[0])
    return page ? Response.json(page, { headers }) : new Response(null, { status: 404, headers })
  },
)
