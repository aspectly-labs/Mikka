import 'server-only'
import { eveClient } from '../eve/server-client'
import { assertEveScope } from '../eve/scope'

/**
 * 停止 in a chat (decision 2026-11-22-1600): whatever the chat is working on, from the moment a send is accepted.
 * Input no turn has taken yet is ended atomically (stop-before-turn.ts); a running turn, or one eve accepted and is
 * starting, is cancelled through eve as the web client cancels it. Owner-scoped: `userId` and `botId` come from the
 * caller's own bot (app/actions/coordinator.ts `ownBot`, the mobile route's own check).
 */
export async function stopChatTurn(userId:string,botId:string):Promise<boolean> {
  const { stopBeforeTurn } = await import('./stop-before-turn')
  const before = await stopBeforeTurn(userId,botId)
  const turn = before.turnRunning ? await cancelRunningTurn(userId,botId) : false
  return before.ended > 0 || before.onTheirWay > 0 || turn
}

/**
 * The eve session running the chat's turn: the one holding the lease, which needs no stream on the page (a reload
 * mid-turn); without a lease, the chat's newest web session, where eve accepted input and runs it. Owner-scoped.
 */
export async function runningTurnSession(userId:string,botId:string) {
  const {pool} = await import('../db')
  return (await pool.query<{session_id:string;workspace_id:string}>(`SELECT s.session_id,s.workspace_id FROM eve_sessions s
    LEFT JOIN coordinator_sessions c ON c."userId"=s.owner_id AND c."botId"=s.bot_id AND c."leaseHolder"=s.session_id AND c."leaseUntil" > now()
    WHERE s.owner_id=$1 AND s.bot_id=$2 AND s.surface='web' ORDER BY (c."leaseHolder" IS NOT NULL) DESC, s.created_at DESC LIMIT 1`,[userId,botId])).rows[0] ?? null
}

async function cancelRunningTurn(userId:string,botId:string) {
  const row = await runningTurnSession(userId,botId)
  if (!row) return false
  const scope = await assertEveScope({ownerId:userId,botId,workspaceId:row.workspace_id,surface:'web'})
  await eveClient(scope).sessions.attach(row.session_id).cancel()
  return true
}
