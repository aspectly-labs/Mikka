import { DEFAULT_MACHINE_SIZE, MACHINE_SIZES, machineHourlyMicroUsd, type MachineSize } from '@/lib/cloud-computer/machine-pricing'
import { organizationSession } from '@/lib/enterprise/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse } from '@/lib/governance/http'
import { listOrganizations } from '@/lib/governance/organizations'
import { defineRoute } from '@/lib/primitives/define-route'


const GETBody = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string }> }) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  const [membership] = await listOrganizations(session.user.id, organizationId)
  if (!membership) throw new GovernanceError('access_denied')
  const sizes = (Object.keys(MACHINE_SIZES) as MachineSize[]).map(id => ({
    id, ...MACHINE_SIZES[id], hourlyMicroUsd: machineHourlyMicroUsd(id),
  }))
  return { defaultSize: DEFAULT_MACHINE_SIZE, sizes }
}))

export const GET = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/machine-sizes',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
