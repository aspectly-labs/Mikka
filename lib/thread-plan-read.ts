import { threadPlan, type ThreadPlanItem } from './thread-plan'

type Queryable = { query: <T>(text: string, values?: unknown[]) => Promise<{ rows: T[] }> }

/**
 * A run's plan over all of its chunks, not the page a reader holds: only the plan calls (TodoWrite, update_plan,
 * TaskCreate, TaskUpdate) and the TaskCreate results that name a task, read through the run's own chunk index and
 * folded by lib/thread-plan.ts. Its owner's only: another person's run, or none, reads as null.
 */
export async function readRunPlan(db: Queryable, input: { runId: string; ownerId: string }): Promise<ThreadPlanItem[] | null> {
  const { rows } = await db.query<{ chunk: Record<string, unknown> }>(`
    SELECT c.chunk FROM run_chunks c JOIN agent_runs r ON r.id = c."runId"
    WHERE c."runId" = $1 AND r."userId" = $2 AND (
      (c.chunk->>'type' = 'tool-input-available' AND lower(c.chunk->>'toolName') IN ('todowrite','update_plan','taskcreate','taskupdate'))
      OR (c.chunk->>'type' IN ('tool-output-available','tool-output-error') AND c.chunk->>'toolCallId' IN (
        SELECT p.chunk->>'toolCallId' FROM run_chunks p WHERE p."runId" = $1
          AND p.chunk->>'type' = 'tool-input-available' AND lower(p.chunk->>'toolName') = 'taskcreate')))
    ORDER BY c.seq`, [input.runId, input.ownerId])
  return threadPlan(rows)
}
