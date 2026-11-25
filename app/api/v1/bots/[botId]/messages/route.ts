import { interopApi, interopBody, limitParam, sendKey } from '@/lib/interop/http'
import { readBotChat, sendToBot } from '@/lib/interop/bots'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ botId: string }> }

/** The latest messages of the Bot owner's chat with this Bot, when shared. */
const handleGET = async (request: Request, { params }: Context) => {
  const { botId } = await params
  return interopApi(request, 'bots:read', principal => readBotChat(principal, botId, limitParam(request)))
}

/** Hand the Bot a peer message and wake it for a turn. */
const handlePOST = async (request: Request, { params }: Context) => {
  const { botId } = await params
  return interopApi(request, 'bots:write', async principal => {
    const body = await interopBody(request)
    return sendToBot(principal, { botId, text: body.text as string, key: sendKey(request, body) as string })
  }, 202)
}

export const GET = defineRoute<'public', 'none', { botId: string }>(
  {
    route: '/api/v1/bots/[botId]/messages',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { botId: string }>(
  {
    route: '/api/v1/bots/[botId]/messages',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handlePOST(request, { params: Promise.resolve(params) }),
)
