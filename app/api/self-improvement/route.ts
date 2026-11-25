import { getApiSession } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { improvementStore, skillAssignments, improvementFactory, skillRegistry, skillEvaluations } from '@/lib/self-improvement/server'
import { handleImprovement } from '@/lib/self-improvement/http'
import { improvementRecordOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'


async function handle(request: Request) {
  const user = (await getApiSession({ headers: request.headers }))?.user
  const respond = () => handleImprovement(improvementStore, request, user?.id ?? null, skillAssignments, improvementFactory, skillRegistry, skillEvaluations,
    record => user ? improvementRecordOutsideToken(user, record) : Promise.resolve(false))
  // Its task checks (issueForUser) keep a workspace token's scope inside actAs; the record's source runs add their Bots.
  return user ? actAs(user, respond) : respond()
}


export const GET = defineRoute<'session', 'none'>(
  { route: '/api/self-improvement', auth: 'session', origin: 'any', workspace: 'none' },
  async ({ request }) => handle(request),
)

export const POST = defineRoute<'session', 'none'>(
  { route: '/api/self-improvement', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
  async ({ request }) => handle(request),
)
