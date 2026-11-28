import { z } from 'zod'
import { cronJob } from '@/lib/background'
import { defineRoute } from '@/lib/primitives/define-route'
import { replayCoordinatorWake, retryCoordinatorWakes } from '@/lib/coordinator/wake'

export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }

/** Cron-only documented exception to read-only GET. Replays use POST. */
const handleGET = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async () => {
    try { return Response.json(await retryCoordinatorWakes(), { headers }) }
    catch { return Response.json({ error: 'coordinatorWakeSweepFailed' }, { status: 502, headers }) }
  },
)

const handlePOST = defineRoute(
  { auth: 'cron-secret', origin: 'any', workspace: 'none' },
  async ({ request }) => {
    const input = z.strictObject({ eventId: z.uuid() }).safeParse(await request.json().catch(() => null))
    if (!input.success) return Response.json({ error: 'invalidWakeReplay' }, { status: 400, headers })
    try { return Response.json({ replayed: await replayCoordinatorWake(input.data.eventId, AbortSignal.any([request.signal, AbortSignal.timeout(45_000)])) }, { headers }) }
    catch { return Response.json({ error: 'coordinatorWakeReplayFailed' }, { status: 502, headers }) }
  },
)

export const GET = cronJob('coordinator-wakes', handleGET)

export const POST = cronJob('coordinator-wakes', handlePOST)
