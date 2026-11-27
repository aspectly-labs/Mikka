import { freshSessionRoute } from '@/lib/fresh-session'
import {
  deleteUserPasskey,
  passkeyAccountSession,
  passkeyJson,
  passkeyRouteResponse,
  renameUserPasskey,
} from '@/lib/account/passkeys'
import { passkeyIdSchema, renamePasskeyBodySchema } from '@/lib/account/passkeys-contract'
import { defineRoute } from '@/lib/primitives/define-route'

const passkeyUnauthorized = () => Response.json(
  { error: { code: 'unauthorized' } },
  { status: 401, headers: { 'cache-control': 'private, no-store' } },
)
const passkeyOriginDenied = () => Response.json(
  { error: { code: 'governance_denied', detail: 'access_denied' } },
  { status: 403, headers: { 'cache-control': 'private, no-store' } },
)

export const PATCH = freshSessionRoute(defineRoute<'session', 'none', { passkeyId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: passkeyOriginDenied,
    onAuthFailure: passkeyUnauthorized,
    desktop: true,
  },
  async ({ request, params }) => passkeyRouteResponse(async () => {
    const session = await passkeyAccountSession(request)
    const id = passkeyIdSchema.parse(params.passkeyId)
    const body = renamePasskeyBodySchema.parse(await passkeyJson(request))
    const passkey = await renameUserPasskey(session.user.id, session.session.id, { id, name: body.name })
    return { passkey }
  }),
))

export const DELETE = freshSessionRoute(defineRoute<'session', 'none', { passkeyId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: passkeyOriginDenied,
    onAuthFailure: passkeyUnauthorized,
    desktop: true,
  },
  async ({ request, params }) => passkeyRouteResponse(async () => {
    const session = await passkeyAccountSession(request)
    const id = passkeyIdSchema.parse(params.passkeyId)
    return deleteUserPasskey(session.user.id, session.session.id, { id })
  }),
))
