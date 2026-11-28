import { interopApi, limitParam, param } from '@/lib/interop/http'
import { listThreads } from '@/lib/interop/threads'
import { defineRoute } from '@/lib/primitives/define-route'

/** Threads in the credential's Workspace it may read (decision 2026-11-19-2200). */
const handleGET = (request: Request) => interopApi(request, 'threads:read', async principal =>
  ({ threads: await listThreads(principal, { issueId: param(request, 'issueId'), limit: limitParam(request) }) }))

export const GET = defineRoute(
  {
    route: '/api/v1/threads',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handleGET(request),
)
