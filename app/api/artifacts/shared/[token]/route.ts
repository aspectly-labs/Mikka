import { sharedArtifact } from '@/lib/artifacts/store'
import { artifactShareViewer } from '@/lib/artifacts/share-viewer'
import { defineRoute } from '@/lib/primitives/define-route'

const privateHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }

async function handleGET(request: Request, token: string) {
  const found = /^mks_[A-Za-z0-9_-]{1,124}$/.test(token) ? await sharedArtifact(token, () => artifactShareViewer(request)) : null
  if (!found) return Response.json({ error: 'not_found' }, { status: 404, headers: privateHeaders })
  const artifact = {
    id: found.id, kind: found.kind, engine: found.engine, externalId: found.externalId,
    artifactType: found.artifactType, embedUrl: found.embedUrl,
    title: found.title, latestVersion: found.latestVersion,
    runId: found.runId, issueId: found.issueId,
    versions: found.versions.map(version => ({
      version: version.version, authorName: version.authorName, authorColor: version.authorColor,
      authorShape: version.authorShape, authorHarness: version.authorHarness, createdAt: version.createdAt,
    })),
  }
  return Response.json({ artifact, markdown: found.engine === 'open_artifact' ? null : (found.kind === 'markdown' ? found.content : null) }, { headers: privateHeaders })
}

/** Public links need their token; restricted links also admit the current viewer.
 * Only the existing ArtifactShared props leave this endpoint. */
export const GET = defineRoute<'public', 'none', { token: string }>(
  { route: '/api/artifacts/shared/[token]', auth: 'public', origin: 'any', workspace: 'none', desktop: true },
  async ({ request, params }) => handleGET(request, params.token),
)
