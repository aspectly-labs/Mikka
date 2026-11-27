/**
 * Write receipts the safety-net sweep (lib/operations/write-receipt-sweep.ts)
 * still has to settle (ADR 2026-11-27-1615, no approvals):
 * - a `pending` proposal, which an older deployment may still insert during a
 *   rollout and nobody can decide any more;
 * - a run-bound receipt still `running` within 7 days whose run is no longer
 *   running: its outcome is read back, never resent.
 * Reads the pending_actions_unresolved_idx partial index; empty on an idle database.
 */
export const WRITE_RECEIPTS_DUE_SQL = `SELECT 1 FROM pending_actions p
  WHERE p.status IN ('pending','running') AND (p.status = 'pending' OR (
    p."operationBinding"->'run' IS NOT NULL AND p."createdAt" > now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM agent_kit_executions e
      WHERE e.id::text = p."operationBinding"->'run'->>'runId' AND e.owner_id = p."userId" AND e.status = 'running')))`

/** Most run-bound receipts one sweep reads back. */
export const WRITE_RECEIPT_READBACK_LIMIT = 50
