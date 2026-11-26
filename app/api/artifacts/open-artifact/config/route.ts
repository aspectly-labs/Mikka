import { readPublicOpenArtifactConfig } from '@/lib/artifacts/open-artifact-config'
import { defineRoute, NO_STORE_PRIVATE_HEADERS, routeJson } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  {
    route: '/api/artifacts/open-artifact/config',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'member',
  },
  async () => routeJson(readPublicOpenArtifactConfig(), 200, NO_STORE_PRIVATE_HEADERS),
)
