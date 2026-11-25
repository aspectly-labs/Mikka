import { interopApi, limitParam, param } from '@/lib/interop/http'
import { listInteropArtifacts } from '@/lib/interop/artifacts'
import { defineRoute } from '@/lib/primitives/define-route'

/** Artifacts of the credential's Workspace it may read (decision 2026-11-19-2200). */
const handleGET = (request: Request) => interopApi(request, 'artifacts:read', async principal =>
  ({ artifacts: await listInteropArtifacts(principal, { runId: param(request, 'runId'), issueId: param(request, 'issueId'), limit: limitParam(request) }) }))

export const GET = defineRoute(
  {
    route: '/api/v1/artifacts',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handleGET(request),
)
