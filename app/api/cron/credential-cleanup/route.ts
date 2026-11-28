import { cronJob } from '@/lib/background'
import { defineRoute } from '@/lib/primitives/define-route'
import { privateHeaders } from '@/lib/credentials/http'
const handleGET = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async () => {
    // Retention hold: no automatic database deletion is authorized.
    return Response.json({ disabled: true }, { headers: privateHeaders })
  },
)

export const GET = cronJob('credential-cleanup', handleGET)
