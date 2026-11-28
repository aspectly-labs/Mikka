import { RouteResponse } from '@/lib/server-runtime/server'
import { defineRoute } from '@/lib/primitives/define-route'
const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'cache-control': 'private, no-store' } })
const spec = { auth: 'session', origin: 'any', workspace: 'pat-scoped' } as const
export const GET = defineRoute<'session', 'pat-scoped'>(spec, () => respond({ available: false, runtime: { harness: 'ai_sdk' } }, 200))
export const PUT = defineRoute<'session', 'pat-scoped'>(spec, () => respond({ error: 'notEnabled' }, 404))
