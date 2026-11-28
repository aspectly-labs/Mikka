import { InteropError } from '@/lib/interop/errors'
import { interopApi, interopBody, param } from '@/lib/interop/http'
import { interopAuthor } from '@/lib/interop/tools'
import { listInteropDrive, writeInteropDriveFile } from '@/lib/interop/drive'
import { defineRoute } from '@/lib/primitives/define-route'

/** A shared Drive scope's folders and its default folder's files (decision 2026-11-19-2200 §4). */
const handleGET = (request: Request) => interopApi(request, 'drive:read', principal => {
  const scope = param(request, 'scope')
  if (!scope) throw new InteropError('interop_invalid_request')
  return listInteropDrive(principal, { scope, scopeId: param(request, 'scopeId'), prefix: param(request, 'prefix') })
})

/** Write one file into the scope's default folder, creating it on the first write (body names scope and scopeId). */
const handlePUT = (request: Request) => interopApi(request, 'drive:write', async principal =>
  writeInteropDriveFile(principal, await interopBody(request), interopAuthor(principal)))

export const GET = defineRoute(
  {
    route: '/api/v1/drive/volumes',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handleGET(request),
)

export const PUT = defineRoute(
  {
    route: '/api/v1/drive/volumes',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handlePUT(request),
)
