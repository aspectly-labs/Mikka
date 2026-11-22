import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { ActionFailureError } from '@/lib/action-error'
import { refreshConnectionModels } from '@/lib/connection-models'

const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

// #2938 (1): manual re-probe — the same LiteLLM model discovery connect/key-change runs.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return respond({ error: 'authRequired' }, 401)
  try {
    const models = await refreshConnectionModels(session.user as never, z.uuid().parse((await params).id))
    return respond({ models }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: error instanceof ActionFailureError ? error.code : 'connectionModelsUnavailable' }, error instanceof ActionFailureError ? 404 : 503)
  }
}
