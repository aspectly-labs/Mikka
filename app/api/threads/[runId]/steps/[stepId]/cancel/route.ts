import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { cancelStepCall } from '@/lib/thread-steps'

export const maxDuration = 60

// Cancel one tool call (#2937): a harness that supports per-call cancel would
// honour it here; today every harness answers the explicit unsupported error.
export async function POST(request: Request, { params }: { params: Promise<{ runId: string; stepId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const { runId, stepId } = await params
    const result = await cancelStepCall(session.user, z.uuid().parse(runId), stepId)
    if (result === 'notFound') return respond({ error: 'stepNotFound' }, 404)
    if (result === 'notRunning') return respond({ error: 'stepNotRunning' }, 409)
    return respond({ error: 'toolCancelUnsupported', supported: false }, 422)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Step cancel unavailable' }, 503)
  }
}
