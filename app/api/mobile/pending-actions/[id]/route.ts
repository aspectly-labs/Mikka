import { json } from '@/lib/mobile-api'
import { defineRoute } from '@/lib/primitives/define-route'

/**
 * Retired: nothing waits for approval (ADR 2026-11-27-1615), so there is
 * nothing to approve or decline. Kept for one release so older phone builds
 * that still post `{ approve }` here get the same answer as the web's retired
 * decision (`pendingActionUnavailable`, 409) instead of a 404. Remove with the
 * hosted follow-up.
 */
export const POST = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/pending-actions/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async () => json({ error: 'pendingActionUnavailable' }, 409),
)
