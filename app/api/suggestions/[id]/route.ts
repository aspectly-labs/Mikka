import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import type { ApiSession } from '@/lib/api-auth'
import { dismissSuggestion } from '@/lib/suggestions/store'
import { defineRoute } from '@/lib/primitives/define-route'


/** Takes one suggestion off the person's list. */
async function handleDELETE(request: Request, user: ApiSession['user'], { params }: { params: Promise<{ id: string }> }) {
  const headers = { 'Cache-Control': 'no-store' }
  if (request.headers.get('origin') !== new URL(request.url).origin) return RouteResponse.json({ error: 'originNotAllowed' }, { status: 403, headers })
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return RouteResponse.json({ error: 'invalidSuggestion' }, { status: 400, headers })
  return await dismissSuggestion(user.id, id) ? new Response(null, { status: 204, headers }) : RouteResponse.json({ error: 'suggestionNotFound' }, { status: 404, headers })
}

export const DELETE = defineRoute<'session', 'none', { id: string }>(
  {
    route: '/api/suggestions/[id]',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none', write: true,
  },
  async ({ request, user, params }) => handleDELETE(request, user, { params: Promise.resolve(params) }),
)
