import type { ApiSession } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { improvementStore, skillAssignments, improvementFactory, skillRegistry, skillEvaluations } from '@/lib/self-improvement/server'
import { handleImprovement } from '@/lib/self-improvement/http'
import { improvementRecordOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'


async function handle(request: Request, user: ApiSession['user']) {
  const respond = () => handleImprovement(improvementStore, request, user.id, skillAssignments, improvementFactory, skillRegistry, skillEvaluations,
    record => improvementRecordOutsideToken(user, record))
  // Its task checks (issueForUser) keep a workspace token's scope inside actAs; the record's source runs add their Bots.
  return actAs(user, respond)
}


export const GET = defineRoute<'session', 'none'>(
  { route: '/api/self-improvement', auth: 'session', origin: 'any', workspace: 'none', desktop: true },
  async ({ request, user }) => handle(request, user),
)

export const POST = defineRoute<'session', 'none'>(
  { route: '/api/self-improvement', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true, desktop: true },
  async ({ request, user }) => handle(request, user),
)
