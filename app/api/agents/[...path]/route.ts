import { proxyEveRequest } from '@/lib/eve-service-proxy'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 800

// Eve owns this protocol's authentication and streaming contract; the guard
// only marks this mount explicitly public and never buffers the proxied body.
const spec = { auth: 'public', origin: 'any', workspace: 'none' } as const
export const GET = defineRoute<'public', 'none', { path: string[] }>(spec, ({ request }) => proxyEveRequest(request))
export const POST = defineRoute<'public', 'none', { path: string[] }>(spec, ({ request }) => proxyEveRequest(request))
export const OPTIONS = defineRoute<'public', 'none', { path: string[] }>(spec, ({ request }) => proxyEveRequest(request))
