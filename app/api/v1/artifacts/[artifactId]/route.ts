import { InteropError } from '@/lib/interop/errors'
import { interopApi, param } from '@/lib/interop/http'
import { readInteropArtifact } from '@/lib/interop/artifacts'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ artifactId: string }> }

/** One artifact version's content, the latest unless `version` is given. */
const handleGET = async (request: Request, { params }: Context) => {
  const { artifactId } = await params
  return interopApi(request, 'artifacts:read', principal => {
    const raw = param(request, 'version')
    const version = raw === undefined ? undefined : Number(raw)
    if (version !== undefined && !Number.isInteger(version)) throw new InteropError('interop_invalid_request')
    return readInteropArtifact(principal, artifactId, version)
  })
}

export const GET = defineRoute<'public', 'none', { artifactId: string }>(
  {
    route: '/api/v1/artifacts/[artifactId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)
