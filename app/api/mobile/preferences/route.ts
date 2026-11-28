import { ActionFailureError } from '@/lib/action-error'
import { json } from '@/lib/mobile-api'
import { preferencesPatch, readPreferences, savePreferences } from '@/lib/preferences'
import { defineRoute } from '@/lib/primitives/define-route'

/** `GET /api/mobile/preferences`: the 通知 and 记忆 settings. */
export const GET = defineRoute(
  {
    route: '/api/mobile/preferences',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'none',
  },
  async ({ user }) => json(await readPreferences(user.id)),
)

/**
 * `PATCH /api/mobile/preferences` with any of the settings; returns all of them.
 * 400 `invalidPreferences` for a malformed patch, 409 `dailySuggestionsNeedMemory`
 * when 每日建议 is turned on while 记忆 is off.
 */
export const PATCH = defineRoute(
  {
    route: '/api/mobile/preferences',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'none',
    write: true,
  },
  async ({ request, user }) => {
    const patch = preferencesPatch.safeParse(await request.json().catch(() => null))
    if (!patch.success) return json({ error: 'invalidPreferences' }, 400)
    try {
      return json(await savePreferences(user.id, patch.data))
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === 'dailySuggestionsNeedMemory') {
        return json({ error: error.code }, 409)
      }
      throw error
    }
  },
)
