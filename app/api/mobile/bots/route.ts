import { ActionFailureError } from '@/lib/action-error'
import { createOwnedBot } from '@/lib/bot-create'
import { json } from '@/lib/mobile-api'
import { defineRoute } from '@/lib/primitives/define-route'
import { workVisibilitySchema } from '@mikka/protocol/work-visibility'

/** `POST /api/mobile/bots`: create a Bot in the person's current workspace, with optional visibility. */
export const POST = defineRoute(
  {
    route: '/api/mobile/bots',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'member',
    write: true,
  },
  async ({ request, user, workspace }) => {
    const body = await request.json().catch(() => null) as { name?: unknown; color?: unknown; shape?: unknown; visibility?: unknown } | null
    const visibility = workVisibilitySchema.optional().safeParse(body?.visibility)
    if (!visibility.success) return json({ error: 'validationGeneric' }, 400)
    try {
      return json(
        await createOwnedBot(
          { ownerId: user.id, workspaceId: workspace.id },
          { name: String(body?.name ?? ''), color: body?.color == null ? undefined : String(body.color), shape: String(body?.shape ?? ''), visibility: visibility.data },
        ),
        201,
      )
    } catch (error) {
      if (error instanceof ActionFailureError) return json({ error: error.code }, error.code === 'botDuplicateName' ? 409 : 400)
      throw error
    }
  },
)
