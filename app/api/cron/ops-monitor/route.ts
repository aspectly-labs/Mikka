import { cronJob } from '@/lib/background'
import { withRequestLog } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'
import { pool } from '@/lib/db'
import { collectOperationalSignals } from '@/lib/ops/monitor'
import { collectProviderEgress } from '@/lib/ops/egress-fallback'
import { isCloudEdition } from '@/lib/edition'
import { publicEnv } from '@/lib/public-env.mjs'

export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
const handleGET = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async () => {
    try {
      const cloud = isCloudEdition()
      const [operational, provider] = await Promise.allSettled([
        collectOperationalSignals(pool, { sink: process.env.OPS_INTERNAL_ALERT_SINK }),
        cloud ? collectProviderEgress(pool, { neonToken: process.env.NEON_API_KEY, posthogKey: publicEnv('MIKKA_PUBLIC_POSTHOG_KEY') })
          : Promise.resolve({ status: 'not_applicable' as const }),
      ])
      if (operational.status !== 'fulfilled' || provider.status !== 'fulfilled') throw Error('opsMonitorUnavailable')
      const result = operational.value, egress = provider.value
      return Response.json({ ...result, egress }, { status: result.databaseAvailable && result.notificationStatus !== 'failed' && egress.status !== 'failed' ? 200 : 503, headers })
    } catch { return Response.json({ error: 'opsMonitorUnavailable', persisted: false }, { status: 503, headers }) }
  },
)
export const GET = withRequestLog('/api/cron/ops-monitor', cronJob('ops-monitor', handleGET))
