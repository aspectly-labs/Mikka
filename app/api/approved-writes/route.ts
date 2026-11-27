import { createPersonalWriteRoute } from '@/lib/operations/write-route'
import { personalWritesEnabled } from '@/lib/operations/write-feature'
import { defineRoute } from '@/lib/primitives/define-route'

const postApprovedWrite = createPersonalWriteRoute({
  enabled: personalWritesEnabled,
  load: async () => (await import('@/lib/operations/write-runtime')).personalWriteRuntime(),
})

/** Public availability only. Never initializes auth, database or provider services. */
export const GET = defineRoute<'public', 'none'>(
  { route: '/api/approved-writes', auth: 'public', origin: 'any', workspace: 'none', desktop: true },
  () => Response.json({ enabled: personalWritesEnabled() }, { headers: { 'cache-control': 'no-store' } }),
)

/** Separate personal browser endpoint; deliberately not a Bot/AgentKit tool.
 * Disabled requests never initialize auth, the DB pool or provider clients. */
export const POST = defineRoute<'public', 'none'>(
  { route: '/api/approved-writes', auth: 'public', origin: 'any', workspace: 'none', desktop: true },
  async ({ request }) => postApprovedWrite(request),
)
