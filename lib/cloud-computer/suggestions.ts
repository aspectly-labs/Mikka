import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Actor } from './subagents'
import { ComputerError } from '@/lib/computer/store'
import { activeTaskWorkspaces } from '@/lib/task-workspace'
import type { RequestWorkspaceUser } from '@/lib/request-workspace'
import { WorkspaceError } from '@/lib/workspace-error'

/**
 * Resolves and authorizes the workspace that owns a suggestion's Coordinator
 * Bot so starting a personal suggestion from a team workspace still persists
 * its execution in the Coordinator's workspace (workflows/coordinator/steps.ts).
 * Returns `null` for legacy suggestions with no Bot or missing suggestions.
 */
export async function resolveSuggestionStartWorkspace(
  pool: Pool,
  user: RequestWorkspaceUser,
  suggestionId: string,
): Promise<string | null> {
  const { rows: [row] } = await pool.query<{ botId: string | null; workspaceId: string | null }>(
    `SELECT s."botId", b."workspaceId"
     FROM suggestions s
     LEFT JOIN bots b ON b.id = s."botId" AND b."ownerId" = s."userId"
     WHERE s.id = $1 AND s."userId" = $2 AND s.shown = true AND s."dismissedAt" IS NULL`,
    [suggestionId, user.id],
  )
  if (!row || !row.botId) return null
  if (!row.workspaceId) throw new ComputerError(404, 'Suggestion unavailable')
  const allowed = await activeTaskWorkspaces(user, row.workspaceId)
  if (!allowed.length) throw new WorkspaceError('workspaceAccessDenied')
  return row.workspaceId
}

/** An idempotent click commits the visible card and full instruction before
 * waking the existing orchestrator. Work kind is chosen by that orchestrator. */
export async function startSuggestion(pool: Pool, actor: Actor, suggestionId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const suggestion = (await client.query('SELECT * FROM suggestions WHERE id=$1 AND "userId"=$2 AND shown=true AND "dismissedAt" IS NULL FOR UPDATE', [suggestionId, actor.userId])).rows[0]
    if (!suggestion) throw new ComputerError(404, 'Suggestion unavailable')
    if (suggestion.botId) {
      const bot = (await client.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [suggestion.botId, actor.userId])).rows[0]
      if (!bot || bot.workspaceId !== actor.workspaceId) throw new ComputerError(404, 'Suggestion unavailable')
    }
    const prior = (await client.query('SELECT * FROM suggestion_executions WHERE "suggestionId"=$1 AND "ownerId"=$2 ', [suggestionId, actor.userId])).rows[0]
    if (prior) {
      if (prior.workspaceId !== actor.workspaceId) throw new ComputerError(404, 'Suggestion unavailable')
      await client.query('COMMIT'); return { suggestionId, botId: null, state: prior.status }
    }
    // The execution names no bot until one takes it; the suggestion starts in the chat it stored (its Coordinator's).
    const botId: string | null = null
    const chat: string | null = suggestion.botId
    const instruction = `Start this suggestion now. Account owner: ${actor.userId}. Source: ${suggestion.source}. Account/actor: ${suggestion.actor ?? 'unspecified'}. Source URL: ${suggestion.url ?? 'unavailable'}. Source item: ${suggestion.title}. Requested action: ${suggestion.actionTitle ?? suggestion.action}. Check the source and its context, then carry out the task. Stop and ask for confirmation before any irreversible operation. Route web work to start_web_subagent; real tasks such as coding to a separate cloud thread. Suggestion id: ${suggestionId}.`
    await client.query('INSERT INTO suggestion_executions ("suggestionId","ownerId","workspaceId","botId",instruction) VALUES ($1,$2,$3,$4,$5)', [suggestionId, actor.userId, actor.workspaceId, botId, instruction])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-chat:${actor.userId}:${chat ?? 'coordinator'}`])
    const position = Number((await client.query('SELECT coalesce(max(position),0) AS n FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid', [actor.userId, chat])).rows[0].n)
    await client.query('INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$7,$8)', [randomUUID(), actor.userId, chat, position + 1, JSON.stringify({ role: 'user', content: suggestion.actionTitle ?? suggestion.title, suggestion: { id: suggestionId, source: suggestion.source } }), randomUUID(), position + 2, JSON.stringify({ role: 'user', content: instruction })])
    await client.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$4,$5) ON CONFLICT DO NOTHING`, [randomUUID(), actor.userId, chat, `suggestion:start:${suggestionId}`, JSON.stringify({ text: instruction, suggestionId, postedToChat: true })])
    await client.query('COMMIT')
    return { suggestionId, botId, state: 'starting' }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
