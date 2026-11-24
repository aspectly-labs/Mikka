import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { readStepOutput } from '@/lib/thread-steps'

export const maxDuration = 60

// Full tool-call output (#2937), segmented by ?offset=&limit=.
export async function GET(request: Request, { params }: { params: Promise<{ runId: string; stepId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    const { runId, stepId } = await params
    const query = z.object({
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(200000).optional(),
    }).parse(Object.fromEntries(new URL(request.url).searchParams))
    const result = await readStepOutput(session.user, z.uuid().parse(runId), stepId, query)
    if (!result) return respond({ error: 'stepNotFound' }, 404)
    return respond(result, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Step output unavailable' }, 503)
  }
}
