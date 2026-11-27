import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { agentImageQuery } from '@/lib/agent-images'
import { findCachedAgentImage } from '@/lib/agent-images-server'
import { defineRoute } from '@/lib/primitives/define-route'

async function handleAgentImagesGET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: agentCopy.crosssiteRequestsAreNotAllowed }, { status: 403, headers })
  const query = agentImageQuery.safeParse(new URL(request.url).searchParams.get('q'))
  if (!query.success) return Response.json({ error: agentCopy.imageKeywordsMustBe2160CharactersAnd }, { status: 400, headers })
  try {
    return Response.json({ image: await findCachedAgentImage(query.data, request.signal) }, { headers })
  } catch {
    return Response.json({ error: agentCopy.imageSourcesAreTemporarilyUnavailableTheResponse }, { status: 502, headers })
  }
}

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/agent/images',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    desktop: true,
  },
  ({ request }) => handleAgentImagesGET(request),
)
