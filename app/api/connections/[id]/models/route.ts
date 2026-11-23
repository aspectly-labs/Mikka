import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { ActionFailureError } from '@/lib/action-error'
import { connectionModels, setConnectionModels } from '@/lib/connection-models'

const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const fail = (error: unknown) => respond({ error: error instanceof ActionFailureError ? error.code : 'connectionModelsUnavailable' }, error instanceof ActionFailureError ? 404 : 503)

// #2938 (1): the connection's model list — [{id, known, enabled}].
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return respond({ error: 'authRequired' }, 401)
  try {
    return respond({ models: await connectionModels(session.user as never, z.uuid().parse((await params).id)) }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return fail(error)
  }
}

// PATCH {models: {id: enabled}} — the enabled flag `按-id-添加` and discovered models share.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return respond({ error: 'authRequired' }, 401)
  try {
    const body = z.object({ models: z.record(z.string().min(1).max(128), z.boolean()) }).parse(await request.json())
    const result = await setConnectionModels(session.user as never, z.uuid().parse((await params).id), body.models)
    return respond({ models: result }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return fail(error)
  }
}
