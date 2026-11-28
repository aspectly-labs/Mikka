import { withRequestLog } from '@/lib/request-log'
import { cronJob } from '@/lib/background'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

const handleGET = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async () => Response.json({ inbox: 0, outbox: 0, disabled: true }),
)

export const GET = withRequestLog('/api/cron/linear-sync', cronJob('linear-sync', handleGET))
