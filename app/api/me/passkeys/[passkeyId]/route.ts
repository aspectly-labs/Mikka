import { freshSessionRoute } from '@/lib/fresh-session'
import {
  deleteUserPasskey,
  passkeyAccountSession,
  passkeyJson,
  passkeyRouteResponse,
  renameUserPasskey,
} from '@/lib/account/passkeys'
import { passkeyIdSchema, renamePasskeyBodySchema } from '@/lib/account/passkeys-contract'

type RouteContext = { params: Promise<{ passkeyId: string }> }

export const PATCH = freshSessionRoute(async (request: Request, { params }: RouteContext) => passkeyRouteResponse(async () => {
  const session = await passkeyAccountSession(request)
  const { passkeyId } = await params
  const id = passkeyIdSchema.parse(passkeyId)
  const body = renamePasskeyBodySchema.parse(await passkeyJson(request))
  const passkey = await renameUserPasskey(session.user.id, session.session.id, { id, name: body.name })
  return { passkey }
}))

export const DELETE = freshSessionRoute(async (request: Request, { params }: RouteContext) => passkeyRouteResponse(async () => {
  const session = await passkeyAccountSession(request)
  const { passkeyId } = await params
  const id = passkeyIdSchema.parse(passkeyId)
  return deleteUserPasskey(session.user.id, session.session.id, { id })
}))
