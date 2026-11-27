import { frameDocument, frameHeaders } from '@mikka/protocol/artifact-frame'
import { routeArtifact } from '@/lib/artifacts/route'
import { defineRoute } from '@/lib/primitives/define-route'


/**
 * `GET /api/artifacts/:id/versions/:n/frame`: an HTML artifact as the page the
 * viewer's sandboxed iframe loads (and 在浏览器打开 opens). Its own CSP
 * sandbox keeps it in an opaque origin either way.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ artifactId: string; version: string }> }) {
  const found = await routeArtifact(request, params)
  if (found instanceof Response) return found
  if (found.kind !== 'html') return new Response('Not found', { status: 404 })
  return new Response(frameDocument(found.content), { headers: frameHeaders() })
}

export const GET = defineRoute<'public', 'none', { artifactId: string; version: string }>(
  {
    route: '/api/artifacts/[artifactId]/versions/[version]/frame',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)
