import 'server-only'
import type { Pool } from 'pg'
import { WRITE_RECEIPT_READBACK_LIMIT } from './write-receipt-due'
import { WRITE_ACTIONS, type WriteActionName } from './write-schema'

type Readback = (ownerId: string, id: string, action: WriteActionName) => Promise<{ status: string }>

/**
 * The receipt part of the safety-net sweep (app/api/cron/reconcile):
 * 1. closes every `pending` proposal as `declined` / `approvalRetired`, so an
 *    older deployment's late insert during a rollout never waits for anyone
 *    (idempotent; `decidedAt` stays empty, so it is not the person's decision);
 * 2. reads back each run-bound receipt still `running` after its run ended,
 *    through the readback-only ledger path: never claims, invokes or resends.
 */
export async function sweepWriteReceipts(pool: Pick<Pool, 'query'>, readback?: Readback) {
  const closed = await pool.query("UPDATE pending_actions SET status='declined',error='approvalRetired' WHERE status='pending'")
  const candidates = await pool.query<{ id: string; userId: string; action: string }>(
    `SELECT p.id, p."userId", p.action FROM pending_actions p
      WHERE p.status = 'running' AND p.action = ANY($1::text[]) AND p."operationBinding"->'run' IS NOT NULL
        AND p."createdAt" > now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM agent_kit_executions e
          WHERE e.id::text = p."operationBinding"->'run'->>'runId' AND e.owner_id = p."userId" AND e.status = 'running')
      ORDER BY p."createdAt" LIMIT $2`, [WRITE_ACTIONS, WRITE_RECEIPT_READBACK_LIMIT])
  const read = readback ?? defaultReadback
  const outcomes: Record<string, number> = {}
  for (const row of candidates.rows) {
    let status: string
    try { status = (await read(row.userId, row.id, row.action as WriteActionName)).status }
    catch { status = 'unavailable' }
    outcomes[status] = (outcomes[status] ?? 0) + 1
  }
  return { retired: closed.rowCount ?? 0, readBack: candidates.rows.length, outcomes }
}

async function defaultReadback(ownerId: string, id: string, action: WriteActionName) {
  const { personalWriteRuntime } = await import('./write-runtime')
  return personalWriteRuntime().operations(action).readback(ownerId, id)
}
