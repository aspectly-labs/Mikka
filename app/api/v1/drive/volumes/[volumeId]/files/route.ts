import { InteropError } from '@/lib/interop/errors'
import { interopApi, interopBody, param, volumeScope } from '@/lib/interop/http'
import { interopAuthor } from '@/lib/interop/tools'
import { listInteropDrive, readInteropDriveFile, writeInteropDriveFile } from '@/lib/interop/drive'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ volumeId: string }> }

/** One file (`?path=`), or the folder's files at its head when no path is given. */
const handleGET = async (request: Request, { params }: Context) => {
  const { volumeId } = await params
  return interopApi(request, 'drive:read', async principal => {
    const target = await volumeScope(principal, volumeId)
    const path = param(request, 'path')
    if (path === undefined) return listInteropDrive(principal, { ...target, prefix: param(request, 'prefix') })
    const encoding = param(request, 'encoding')
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') throw new InteropError('interop_invalid_request')
    return readInteropDriveFile(principal, { ...target, path, encoding }, request.signal)
  })
}

/** Write or delete one file with the folder's compare-and-swap (`expectedDigest`). */
const handlePUT = async (request: Request, { params }: Context) => {
  const { volumeId } = await params
  return interopApi(request, 'drive:write', async principal => {
    const target = await volumeScope(principal, volumeId)
    const body = await interopBody(request)
    return writeInteropDriveFile(principal, { ...body, ...target }, interopAuthor(principal))
  })
}

export const GET = defineRoute<'public', 'none', { volumeId: string }>(
  {
    route: '/api/v1/drive/volumes/[volumeId]/files',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)

export const PUT = defineRoute<'public', 'none', { volumeId: string }>(
  {
    route: '/api/v1/drive/volumes/[volumeId]/files',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handlePUT(request, { params: Promise.resolve(params) }),
)
