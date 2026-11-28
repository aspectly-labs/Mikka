import { cronJob } from '@/lib/background'
import { defineRoute } from '@/lib/primitives/define-route'
import { deliverWorkspaceAudits } from '@/lib/audit/delivery'
import { sweepAuditRetention } from '@/lib/audit/retention'
import { maintainEnterpriseGovernance } from '@/lib/enterprise/maintenance'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
const handleGET = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async () => {
    try {
      const delivery = await deliverWorkspaceAudits()
      const enterprise = await maintainEnterpriseGovernance()
      return Response.json({ ...await sweepAuditRetention(), delivery, enterprise }, { headers })
    }
    catch { return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers }) }
  },
)

export const GET = cronJob('audit-retention', handleGET)
