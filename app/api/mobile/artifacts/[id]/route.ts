import { z } from 'zod'
import { artifactOutsideToken } from '@/lib/tokens/scope'
import { deleteOwnArtifact } from '@/lib/artifacts/delete'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { defineRoute } from '@/lib/primitives/define-route'


const notFound = () => Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })

/**
 * `DELETE /api/mobile/artifacts/<id>`: deletes one of the person's own files
 * from a bot's 资料库, from the web or the phone (R-51). Signed in like the
 * artifact reads (lib/artifacts/route.ts); a workspace token reaches only its
 * workspace's artifacts. Someone else's, one outside the token, an unknown id
 * and one already deleted all read as 404.
 */
export const DELETE = defineRoute<'mobile-or-session', 'none', { id: string }>(
  {
    route: '/api/mobile/artifacts/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'none',
    write: true,
  },
  async ({ user, params }) => {
    const id = z.uuid().safeParse(params.id)
    if (!id.success) return notFound()
    if (await artifactOutsideToken(user, id.data)) return notFound()
    const context = await loadWorkspaceContext(undefined, user)
    if (!await deleteOwnArtifact({ id: user.id, [tokenWorkspace]: context.workspace.id, [enterprisePrincipal]: user[enterprisePrincipal] }, id.data)) return notFound()
    return new Response(null, { status: 204 })
  },
)
