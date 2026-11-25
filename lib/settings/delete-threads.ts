import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { realCliMembershipGuard } from '@/lib/agent-tool-approval/policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { isRunChainRootSql } from '@/lib/run-chain'
import { runListChanged } from '@/lib/live/lists'
import { runChanged } from '@/lib/live/panels'
import { THREAD_RESTORE_DAYS } from '@/lib/thread-lifecycle-owner'

export async function deleteOwnedWorkspaceThreads(userId: string, workspaceId: string) {
  return writeTransaction(pool, async tx => {
    const { rows } = await tx.query<{ id: string; status: string; root: boolean }>(
      `SELECT r.id,r.status,${isRunChainRootSql('r')} AS root FROM agent_runs r
       WHERE r."userId"=$1 AND r."workspaceId"=$2 AND r.kind<>'group_chat' AND r."deletedAt" IS NULL
       ORDER BY r.id FOR UPDATE OF r`, [userId, workspaceId])
    if (rows.some(row => (UNFINISHED_RUN_STATUSES as readonly string[]).includes(row.status))) return { error: 'threadWorking' } as const
    const count = rows.filter(row => row.root).length
    if (rows.length) {
      await tx.query(`UPDATE agent_runs SET "deletedAt"=now(),"deletedBy"=$1,"updatedAt"=now()
        WHERE "userId"=$1 AND "workspaceId"=$2 AND id=ANY($3::uuid[])`, [userId, workspaceId, rows.map(row => row.id)])
      if (count) await recordAudit(drizzle(tx), { workspaceId, actor: { type: 'user', id: userId, name: userId },
        action: 'thread.bulk_deleted', metadata: { count } })
      for (const row of rows) {
        await runListChanged(tx, row.id)
        await runChanged(tx, row.id)
      }
    }
    return { deleted: count, recoveryDays: THREAD_RESTORE_DAYS }
  }, { guard: (_tx, signal) => realCliMembershipGuard(workspaceId, userId, signal) })
}
