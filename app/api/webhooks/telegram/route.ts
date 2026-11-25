import { timingSafeEqual } from 'node:crypto'
import { getTelegramBot, isTelegramConfigured } from '@/lib/telegram/bot'
import { defineRoute } from '@/lib/primitives/define-route'
// oxlint-disable-next-line no-restricted-imports -- the chat SDK hands over a task that is already running under this webhook's label
import { after } from '@/lib/server-runtime/server'

function verifyTelegramWebhook(request: Request) {
  if (!isTelegramConfigured()) return new Response('Telegram webhook is not configured', { status: 503 })
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
  if (!secret) return new Response('Telegram webhook is not configured', { status: 503 })
  const header = request.headers.get('x-telegram-bot-api-secret-token')
  try {
    if (header && timingSafeEqual(Buffer.from(header), Buffer.from(secret))) return { ok: true as const }
  } catch {
    // timingSafeEqual refuses unequal lengths; the adapter treats that as invalid.
  }
  return new Response('Invalid secret token', { status: 401 })
}

export const POST = defineRoute<'webhook-signature', 'none'>(
  {
    route: '/api/webhooks/telegram',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifyTelegramWebhook,
  },
  async ({ request }) => {
    try {
      return await getTelegramBot().webhooks.telegram(request, { waitUntil: task => after(() => task) })
    } catch (error) {
      console.error('Telegram webhook processing failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      return new Response('Telegram webhook processing failed', { status: 500 })
    }
  },
)
