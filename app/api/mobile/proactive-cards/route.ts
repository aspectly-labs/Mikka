import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { readMobileProactiveCards } from '@/lib/mobile-proactive-cards'

/**
 * `GET /api/mobile/proactive-cards`: Coordinator proactive cards for mobile
 * (today's briefing summary, pending external write proposals, and active
 * suggestions / in-progress handoffs). Pass `?readonly=1` for side-effect-free
 * background/count checks.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const params = new URL(request.url).searchParams
  return json(
    await readMobileProactiveCards(user, {
      timeZone: params.get('tz'),
      ipTimeZone: request.headers.get('x-vercel-ip-timezone'),
      locale: params.get('locale'),
      readonly: params.get('readonly') === '1',
    }),
  )
}

export const GET = withRequestLog('/api/mobile/proactive-cards', handleGET)
