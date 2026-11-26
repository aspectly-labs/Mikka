'use server'

import { headers } from '@/lib/server-runtime/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { desktopNotifyQuestions, filterDesktopCandidates, readDesktopNotify, type DesktopCandidate } from '@/lib/platform/desktop-notifications'
import { readPreferences } from '@/lib/preferences'
import { inDndWindow, pushAllowed } from '@/lib/push-allowed'
import { readDesktopNotificationRuntime } from '@/lib/settings/notification-preferences'
import { listTaskRuns, listThreads } from './task-runs'

const runCandidate = z.object({ id: z.string().max(300), issueId: z.string().max(100), kind: z.enum(['awaiting', 'failed', 'finished']) })
// A merged pull request names its thread; a mention names its group message. Both are re-read here.
const mergedCandidate = z.object({ id: z.string().max(300), kind: z.literal('merged'), runId: z.string().max(100) })
const mentionCandidate = z.object({ id: z.string().max(300), kind: z.literal('mentioned'), messageId: z.uuid() })
const candidatesSchema = z.array(z.union([runCandidate, mergedCandidate, mentionCandidate])).max(20)
const STATUS = { awaiting: 'waiting_input', failed: 'failed', finished: 'succeeded' } as const

/** The person's own merged threads among `runIds`, named as the thread list names them. */
async function mergedCandidates(items: readonly z.infer<typeof mergedCandidate>[]): Promise<DesktopCandidate[]> {
  if (!items.length) return []
  const threads = new Map((await listThreads()).map(thread => [thread.id, thread]))
  return items.flatMap(item => {
    const thread = threads.get(item.runId)
    return thread?.pullState === 'merged' ? [{ id: item.id, kind: 'merged' as const, title: thread.title || thread.prompt.split('\n')[0]!.slice(0, 120), agent: thread.agentName }] : []
  })
}

/** Group messages that @-mention the signed-in person, in a group they are still in, written by someone else. */
async function mentionCandidates(userId: string, items: readonly z.infer<typeof mentionCandidate>[]): Promise<DesktopCandidate[]> {
  if (!items.length) return []
  const { pool } = await import('@/lib/db')
  const { rows } = await pool.query<{ id: string; title: string; author: string | null }>(
    `SELECT m.id, c.title, u.name AS author FROM conversation_messages m
       JOIN conversations c ON c.id = m."conversationId" AND c.kind = 'group'
       JOIN conversation_members cm ON cm."conversationId" = c.id AND cm."memberType" = 'user' AND cm."memberId" = $2 AND cm."leftAt" IS NULL
       LEFT JOIN "user" u ON m."authorType" = 'user' AND u.id = m."authorId"
      WHERE m.id = ANY($1::uuid[])
        AND m.mentions @> jsonb_build_array(jsonb_build_object('memberType', 'user', 'memberId', $2::text))
        AND NOT (m."authorType" = 'user' AND m."authorId" = $2)`,
    [items.map(item => item.messageId), userId])
  const found = new Map(rows.map(row => [row.id, row]))
  return items.flatMap(item => {
    const row = found.get(item.messageId)
    return row ? [{ id: item.id, kind: 'mentioned' as const, title: row.title, agent: row.author ?? '' }] : []
  })
}

/**
 * Which run transitions the desktop app shows as system notifications: the
 * Decisions API decides (lib/platform/desktop-notifications.ts). Only the
 * signed-in person's own runs, in the state the candidate names, are judged.
 */
export async function chooseDesktopNotifications(raw: unknown): Promise<ActionResult<{ show: string[] }>> {
  return runAction(async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const parsed = candidatesSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.length) return { show: [] }
    const userId = session.user.id
    const runItems = parsed.data.filter((item): item is z.infer<typeof runCandidate> => 'issueId' in item)
    const runs = runItems.length ? new Map((await listTaskRuns()).map(run => [run.issueId, run])) : new Map()
    let candidates: DesktopCandidate[] = [
      ...runItems.flatMap(item => {
        const run = runs.get(item.issueId)
        return run && run.status === STATUS[item.kind] ? [{ id: item.id, kind: item.kind, title: run.issueTitle, agent: run.agentName }] : []
      }),
      ...await mergedCandidates(parsed.data.filter((item): item is z.infer<typeof mergedCandidate> => item.kind === 'merged')),
      ...await mentionCandidates(userId, parsed.data.filter((item): item is z.infer<typeof mentionCandidate> => item.kind === 'mentioned')),
    ]
    if (!candidates.length) return { show: [] }
    const runtime = await readDesktopNotificationRuntime(userId)
    if (inDndWindow(runtime.dnd, runtime.timeZone)) return { show: [] }
    let finishedAllowed = true
    // Preferences affect completed-run notifications unless overridden by desktop-specific settings.
    if (candidates.some(candidate => candidate.kind === 'finished')) {
      const preferences = await readPreferences(userId)
      finishedAllowed = pushAllowed(preferences, ['finished'], { overrides: runtime.desktop, dnd: runtime.dnd, timeZone: runtime.timeZone })
    }
    candidates = filterDesktopCandidates(candidates, {
      dnd: runtime.dnd,
      timeZone: runtime.timeZone,
      overrides: runtime.desktop,
      legacyDecide: runtime.legacyPushDecide,
      finishedAllowed,
    })
    if (!candidates.length) return { show: [] }
    const [{ decide }, { hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('@/lib/coordinator/decide'), import('@/lib/abuse/context'), import('@/lib/execution-settings')])
    let answers = null
    try { answers = await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, null), ownerId: userId }, () => decide('desktop-notify', candidates.map(candidate => `${candidate.id}: ${candidate.kind}`).join('\n'), desktopNotifyQuestions(candidates))) } catch { answers = null }
    return { show: readDesktopNotify(answers, candidates) }
  })
}
