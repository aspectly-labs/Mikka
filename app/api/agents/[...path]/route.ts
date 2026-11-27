import { proxyEveRequest } from '@/lib/eve-service-proxy'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 800

// Eve owns this protocol's authentication and streaming contract; the guard
// only marks this mount explicitly public and never buffers the proxied body.
const spec = { auth: 'public', origin: 'any', workspace: 'none' } as const
// The desktop reaches only Eve's own session protocol below this mount.
export const GET = defineRoute<'public', 'none', { path: string[] }>({
  auth: 'public', origin: 'any', workspace: 'none',
  desktop: [
    '/api/agents/eve/v1/session/[id]',
    '/api/agents/eve/v1/session/[id]/stream',
    '/api/agents/eve/v1/session/[id]/stubs',
    '/api/agents/eve/v1/session/[id]/descendants/stream',
    '/api/agents/eve/v1/session/[id]/subagents/[parent]/[child]/stream',
  ],
}, ({ request }) => proxyEveRequest(request))
export const POST = defineRoute<'public', 'none', { path: string[] }>({
  auth: 'public', origin: 'any', workspace: 'none',
  desktop: [
    '/api/agents/eve/v1/session',
    '/api/agents/eve/v1/session/[id]',
    '/api/agents/eve/v1/session/[id]/cancel',
    '/api/agents/eve/v1/session/[id]/compact',
    '/api/agents/eve/v1/session/[id]/clear',
    '/api/agents/eve/v1/session/[id]/end',
    '/api/agents/eve/v1/session/[id]/reset',
  ],
}, ({ request }) => proxyEveRequest(request))
export const OPTIONS = defineRoute<'public', 'none', { path: string[] }>(spec, ({ request }) => proxyEveRequest(request))
