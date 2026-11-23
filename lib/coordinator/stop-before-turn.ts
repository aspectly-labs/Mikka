import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '../db'
import { botChatLockSql, projectEventMessage } from '../eve/submission'
import { nativePendingForChat } from '../eve/pending'

/**
 * 停止 on input a chat accepted that no turn runs yet (decision 2026-11-22-1600, as ChatGPT and Claude: Stop is there
 * the moment a send is accepted). Under the chat's lock, the one eve acceptance and the outbox claim also take:
 * - input nothing has claimed is ended here: it is stored as the person's message with a stopped reply under it, and
 *   delivered, so no turn ever starts for it;
 * - input already on its way to eve is marked; its acceptance then stops the turn it starts (markEventAccepted);
 * - `turnRunning` says a turn has the chat (its lease, or input eve accepted and runs): the caller stops that turn.
 * Owner-scoped by `userId` and `botId`: it never reads or writes another person's chat.
 */
export async function stopBeforeTurn(userId: string, botId: string) {
  const [{ botChatChanged }, { coordinatorSessionChanged }] = await Promise.all([import('../live/chats'), import('../live/coordinator-session')])
  return await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${botChatLockSql(userId, botId)},0))`)
    const ended = (await tx.execute(sql`UPDATE coordinator_events SET "deliveredAt"=now(),"wakeLeaseUntil"=NULL,payload=payload || '{"stoppedBeforeTurn":true}'::jsonb
      WHERE "userId"=${userId} AND "botId"=${botId}::uuid AND kind='user_message' AND "deliveredAt" IS NULL
        AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= now())
      RETURNING id,kind,"runId","issueId",payload,tier,"createdAt"`)).rows as { createdAt: string }[]
    const onTheirWay = (await tx.execute(sql`UPDATE coordinator_events SET payload=payload || '{"stopRequested":true}'::jsonb
      WHERE "userId"=${userId} AND "botId"=${botId}::uuid AND kind='user_message' AND "deliveredAt" IS NULL AND "wakeLeaseUntil" > now()
      RETURNING id`)).rows.length
    const scope = { ownerId: userId, botId }
    for (const event of ended.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) await projectEventMessage(tx, scope, event, false)
    if (ended.length) {
      // The stopped reply under them, as a stopped turn shows it (「已停止」): an empty reply marked stopped.
      await tx.execute(sql`INSERT INTO coordinator_messages(id,"userId","botId",position,message) SELECT ${crypto.randomUUID()}::uuid,${userId},${botId}::uuid,coalesce(max(position),0)+1,${JSON.stringify({ role: 'assistant', content: [], mikkaStopped: true })}::jsonb FROM coordinator_messages WHERE "userId"=${userId} AND "botId"=${botId}::uuid`)
      await botChatChanged(tx, userId, botId)
      await coordinatorSessionChanged(tx, userId, botId)
    }
    const turn = (await tx.execute(sql`SELECT
        exists(SELECT 1 FROM coordinator_sessions WHERE "userId"=${userId} AND "botId"=${botId}::uuid AND "leaseHolder" IS NOT NULL AND "leaseUntil" > now()) AS leased,
        ${nativePendingForChat(userId, botId)} AS accepted`)).rows[0] as { leased: boolean; accepted: boolean }
    return { ended: ended.length, onTheirWay, turnRunning: Boolean(turn?.leased || turn?.accepted) }
  })
}
