import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { readCapture } from '@/lib/captures/store'
import { captureFileResponse } from '@/lib/captures/serve'
import { captureOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'


/** `GET /api/captures/:captureId`: one of the person's screenshots or recordings. */
async function handleGET(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return new Response('Sign in to view this.', { status: 401 })
  const { captureId } = await params
  const found = z.uuid().safeParse(captureId).success && !await captureOutsideToken(session.user, captureId) ? await readCapture(session.user.id, captureId) : null
  if (!found) return new Response('Not found', { status: 404 })
  return captureFileResponse(request, found, { 'cache-control': 'private, no-store' })
}

export const GET = defineRoute<'public', 'none', { captureId: string }>(
  {
    route: '/api/captures/[captureId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)
