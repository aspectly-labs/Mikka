import { defineRoute } from '@/lib/primitives/define-route'
import { RouteResponse } from '@/lib/server-runtime/server'
import { previewWorkspaceInvitation } from '@/lib/workspace-invitation-preview'

const PREVIEW_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

// Public anti-enumeration preview: malformed, unknown, accepted, revoked, expired, and
// archived-organization tokens all answer the same 404 with zero recipient PII or internal IDs.
export const GET = defineRoute<'public', 'none', { token: string }>(
  {
    route: '/api/invitations/[token]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  async ({ params }) => {
    const preview = await previewWorkspaceInvitation(params.token)
    if (!preview) return RouteResponse.json({ error: 'invitationNotFound' }, { status: 404, headers: PREVIEW_HEADERS })
    return RouteResponse.json(preview, { headers: PREVIEW_HEADERS })
  },
)
