import { RouteResponse } from '@/lib/server-runtime/server'
import { afterJob } from '@/lib/background'
import { z } from 'zod'
import { attentionBudgets, setAttentionEnabled } from '@/lib/attention/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

/** Whether the Coordinator is handed matters from connected apps (R-20), and both budgets as they stand. */
export const GET = defineRoute<'session', 'pat-scoped'>(
  { auth: 'session', origin: 'any', workspace: 'pat-scoped', desktop: true },
  async ({ user }) => RouteResponse.json(await attentionBudgets(user.id), { headers }),
)

/** The person's off switch. Off settles what waits as quiet; 建议 keeps filling either way. */
export const PUT = defineRoute<'session', 'pat-scoped'>(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'pat-scoped', write: true },
  async ({ request, user }) => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return RouteResponse.json({ error: 'originMismatch' }, { status: 403, headers })
    const parsed = z.object({ enabled: z.boolean() }).safeParse(await request.json().catch(() => null))
    if (!parsed.success) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
    await setAttentionEnabled(user.id, parsed.data.enabled)
    if (parsed.data.enabled) afterJob('after:coordinator-wake', () => wakeCoordinator(user.id))
    return RouteResponse.json(await attentionBudgets(user.id), { headers })
  },
)
