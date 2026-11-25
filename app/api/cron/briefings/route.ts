import { withRequestLog } from '@/lib/request-log'
import { cronJob } from '@/lib/background'
import { defineRoute } from '@/lib/primitives/define-route'
import { writeDueBriefings } from '@/lib/suggestions/store'

export const maxDuration = 60

/** Leaves time to answer before maxDuration; whoever is left is written by the next run. */
const BUDGET_MS = 40_000

// Called every 15 minutes by the Cloudflare Worker in cloudflare/suggestions-cron.
const handleGET = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async () => {
    const result = await writeDueBriefings({ deadline: Date.now() + BUDGET_MS })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  },
)

export const GET = withRequestLog('/api/cron/briefings', cronJob('briefings', handleGET))
