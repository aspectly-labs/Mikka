import 'server-only'
import type { Pool } from 'pg'
import { WRITE_RECEIPT_READBACK_LIMIT } from './write-receipt-due'
import { WRITE_ACTIONS, type WriteActionName } from './write-schema'
import { OperationError } from './write-error'

/** How long one sweep keeps starting readbacks; each is itself bounded (30s). */
export const WRITE_RECEIPT_SWEEP_BUDGET_MS = 60_000

type Readback = (ownerId: string, id: string, action: WriteActionName) => Promise<{ status: string }>

/** The executable browser mutation leaves a closed browser_operation row
 * (lib/cloud-computer/action-reviews.ts); the masked summary and digest stay. */
const SCRUB_BROWSER_MUTATION = `CASE WHEN action = 'browser_operation' AND input ? 'mutation'
  THEN (input - 'mutation') || '{"mutationScrubbed":true}'::jsonb ELSE input END`

/**
 * The receipt part of the safety-net sweep (app/api/cron/reconcile):
 * 1. closes every `pending` proposal as `declined` / `approvalRetired`, so an
 *    older deployment's late insert during a rollout never waits for anyone
 *    (idempotent; `decidedAt` stays empty, so it is not the person's decision);
 *    a late browser action loses its executable mutation in the same statement;
 * 2. reads back each run-bound receipt still `running` after its run ended,
 *    through the readback-only ledger path: never claims, invokes or resends.
 *    One receipt is claimed at a time, right before its readback starts: the
 *    claim stamps "readbackAttemptAt", so a stamp always means a readback was
 *    started, and reads go in claim order. Claims go to receipts never tried,
 *    then the one tried longest ago, so receipts no provider can settle never
 *    starve newer ones; one tried in the last five minutes is skipped, so
 *    overlapping sweeps never read the same receipt. The sweep stops claiming
 *    after `limit` receipts or once its time budget is spent; receipts it did
 *    not reach keep their previous stamp. A failed readback leaves the receipt
 *    `running` and is counted under `failures` by error code or name only
 *    (never its message).
 */
export async function sweepWriteReceipts(pool: Pick<Pool, 'query'>, readback?: Readback, options: { limit?: number; budgetMs?: number; now?: () => number } = {}) {
  const closed = await pool.query(`UPDATE pending_actions SET status='declined', error='approvalRetired', input=${SCRUB_BROWSER_MUTATION} WHERE status='pending'`)
  const now = options.now ?? Date.now
  const deadline = now() + (options.budgetMs ?? WRITE_RECEIPT_SWEEP_BUDGET_MS)
  const limit = options.limit ?? WRITE_RECEIPT_READBACK_LIMIT
  const read = readback ?? defaultReadback
  const outcomes: Record<string, number> = {}, failures: Record<string, number> = {}
  let readBack = 0
  while (readBack < limit && now() < deadline) {
    const claimed = await pool.query<{ id: string; userId: string; action: string }>(
      `UPDATE pending_actions p SET "readbackAttemptAt" = now()
      WHERE p.id = (SELECT c.id FROM pending_actions c
        WHERE c.status = 'running' AND c.action = ANY($1::text[]) AND c."operationBinding"->'run' IS NOT NULL
          AND c."createdAt" > now() - interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM agent_kit_executions e
            WHERE e.id::text = c."operationBinding"->'run'->>'runId' AND e.owner_id = c."userId" AND e.status = 'running')
          AND (c."readbackAttemptAt" IS NULL OR c."readbackAttemptAt" < now() - interval '5 minutes')
        ORDER BY c."readbackAttemptAt" ASC NULLS FIRST, c."createdAt", c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
      RETURNING p.id, p."userId", p.action`, [WRITE_ACTIONS])
    const row = claimed.rows[0]
    if (!row) break
    readBack++
    let status: string
    try { status = (await read(row.userId, row.id, row.action as WriteActionName)).status }
    catch (error) {
      status = 'unavailable'
      const code = failureCode(error)
      failures[code] = (failures[code] ?? 0) + 1
    }
    outcomes[status] = (outcomes[status] ?? 0) + 1
  }
  return { retired: closed.rowCount ?? 0, readBack, outcomes, ...(Object.keys(failures).length ? { failures } : {}) }
}

/** A stable code, never a message: OperationError's message is its code; anything else gives its `code` or `name`. */
function failureCode(error: unknown) {
  if (error instanceof OperationError) return error.message
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code
  return error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'unknown'
}

async function defaultReadback(ownerId: string, id: string, action: WriteActionName) {
  const { personalWriteRuntime } = await import('./write-runtime')
  return personalWriteRuntime().operations(action).readback(ownerId, id)
}
