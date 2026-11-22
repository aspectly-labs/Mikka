import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-failure'
import { runOutsideToken } from '@/lib/tokens/scope'
import { profileMarkStateOf, type ProfileMarkState } from '@/lib/factory/agent-profile-mark'

/** A sub-agent card on the parent's thread (F #2939): everything the card shows
 * plus `mark`, the shared ProfileMark visual state, so live status and card
 * colours stay on one mapping. */
export type SubagentRunCard = {
  id: string
  name: string | null
  profile: { icon: string; color: string } | null
  brief: string | null
  status: string
  mark: ProfileMarkState
  model: string | null
  botId: string | null
  lastReply: string | null
  createdAt: string
}

type ScopedUser = { id: string } & Record<symbol, unknown>

async function ownedRun(user: ScopedUser, runId: string) {
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, user.id))).limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  return run
}

/** The parent's direct children, creation order. Every live-status change already
 * invalidates the parent's panel via `runLiveTargets` (parentRunId is part of its
 * parent fan-out); once C's soft delete lands, filter `deletedAt` here too. */
export async function listSubagentRuns(user: ScopedUser, runId: string): Promise<SubagentRunCard[]> {
  await ownedRun(user, runId)
  const outside = new Set(await runOutsideToken(user as never, []))
  const rows = await db.select({
    id: agentRuns.id, name: agentRuns.name, profile: agentRuns.profile, brief: agentRuns.brief,
    status: agentRuns.status, outcome: agentRuns.outcome, model: agentRuns.observedModel,
    botId: agentRuns.botId, lastReply: agentRuns.lastReply, createdAt: agentRuns.createdAt,
  }).from(agentRuns)
    .where(and(eq(agentRuns.parentRunId, runId), eq(agentRuns.threadRelation, 'subagent')))
    .orderBy(asc(agentRuns.createdAt))
  return rows
    .filter(row => !outside.has(row.id))
    .map(row => ({
      id: row.id, name: row.name, profile: row.profile, brief: row.brief,
      status: row.status,
      mark: profileMarkStateOf({ status: row.status, outcome: row.outcome }),
      model: row.model, botId: row.botId, lastReply: row.lastReply,
      createdAt: row.createdAt.toISOString(),
    }))
}
