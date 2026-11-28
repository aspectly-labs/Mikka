import { sharedCapture } from '@/lib/captures/store'
import { captureFileResponse } from '@/lib/captures/serve'
import { defineRoute } from '@/lib/primitives/define-route'


/** `GET /api/captures/shared/:token`: a capture behind a live share link, as artifact links work. */
async function handleGET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const found = await sharedCapture((await params).token)
  if (!found) return new Response('Not found', { status: 404 })
  return captureFileResponse(request, found, { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' })
}

export const GET = defineRoute<'public', 'none', { token: string }>(
  {
    route: '/api/captures/shared/[token]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)
