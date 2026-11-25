import { interopApi, interopBody, sendKey } from '@/lib/interop/http'
import { readThreadMessages, sendToThread } from '@/lib/interop/threads'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ runId: string }> }

/** A thread's attempts, messages and agent text, masked (decision 2026-11-19-2200). */
const handleGET = async (request: Request, { params }: Context) => {
  const { runId } = await params
  return interopApi(request, 'threads:read', principal => readThreadMessages(principal, runId))
}

/** Send to a thread and wake it; an ended thread continues in the same thread. */
const handlePOST = async (request: Request, { params }: Context) => {
  const { runId } = await params
  return interopApi(request, 'threads:write', async principal => {
    const body = await interopBody(request)
    return sendToThread(principal, { runId, text: body.text as string, key: sendKey(request, body) as string, delivery: body.delivery as 'queue' | 'steer' | undefined })
  }, 202)
}

export const GET = defineRoute<'public', 'none', { runId: string }>(
  {
    route: '/api/v1/threads/[runId]/messages',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { runId: string }>(
  {
    route: '/api/v1/threads/[runId]/messages',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handlePOST(request, { params: Promise.resolve(params) }),
)
