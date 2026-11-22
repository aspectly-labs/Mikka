import 'server-only'
import { pool } from '@/lib/db'
import { readRunChain } from '@/lib/run-chain'
import { runOutsideToken } from '@/lib/tokens/scope'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'
import type { RequestWorkspaceUser } from '@/lib/request-workspace'

// #2937: full tool-call output, read in segments by the call's `outputRef`.
// `outputRef` is the projected step id — the toolCallId, run-prefixed when the
// thread's chunks span several runs (lib/issue-run-conversation.ts chainChunks).

type ApiUser = RequestWorkspaceUser
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The run ids of the caller's own chain, or null when the run isn't theirs/in-scope. */
async function chainRunIds(user: ApiUser, runId: string): Promise<string[] | null> {
  if (!UUID.test(runId)) return null
  const { rows: [run] } = await pool.query(`SELECT "userId" FROM agent_runs WHERE id=$1`, [runId])
  if (!run || run.userId !== user.id) return null
  if (await runOutsideToken(user, runId)) return null
  const chain = await readRunChain(pool, user.id, runId)
  if (!chain) return null
  return chain.attempts.map(attempt => String(attempt.runId))
}

const OUTPUT_READ_MAX = 200_000

export async function readStepOutput(user: ApiUser, runId: string, stepId: string, segment: { offset?: number; limit?: number }) {
  const runIds = await chainRunIds(user, runId)
  if (!runIds) return null
  const offset = Math.max(0, segment.offset ?? 0), limit = Math.min(Math.max(1, segment.limit ?? OUTPUT_READ_MAX), OUTPUT_READ_MAX)
  const { rows: [row] } = await pool.query(
    `SELECT chunk->>'toolCallId' AS "callId", chunk->>'type' AS type, chunk->'output' AS output, chunk->>'errorText' AS "errorText", chunk->>'toolName' AS "toolName"
     FROM run_chunks WHERE "runId" = ANY($1::uuid[]) AND ((chunk->>'toolCallId')=$2 OR (chunk->>'toolCallId') LIKE '%:' || $2)
     ORDER BY CASE WHEN chunk->>'type'='tool-output-available' THEN 0 WHEN chunk->>'tool-output-error' THEN 1 ELSE 2 END LIMIT 1`,
    [runIds, stepId])
  if (!row) return null
  if (row.type === 'tool-input-available') {
    return { toolCallId: row.callId, toolName: row.toolName ?? null, status: 'running' as const, output: '', hasMore: false }
  }
  const raw = row.output ?? row.errorText
  const masked = maskDeep(raw, credentialMasker)
  const output = typeof masked === 'string' ? masked : JSON.stringify(masked)
  return {
    toolCallId: row.callId, toolName: row.toolName ?? null,
    status: row.type === 'tool-output-error' ? 'failed' as const : 'ok' as const,
    output: output.slice(offset, offset + limit), offset, totalLength: output.length,
    hasMore: offset + limit < output.length,
  }
}

/** #2937 cancel-one-call: the run's harness must support per-call cancel; none do today. */
export async function cancelStepCall(user: ApiUser, runId: string, stepId: string): Promise<'notFound' | 'unsupported' | 'notRunning'> {
  const runIds = await chainRunIds(user, runId)
  if (!runIds) return 'notFound'
  const { rows: [step] } = await pool.query(
    `SELECT chunk->>'type' AS type FROM run_chunks WHERE "runId" = ANY($1::uuid[]) AND chunk->>'toolCallId'=$2
     ORDER BY seq DESC LIMIT 1`, [runIds, stepId])
  if (!step) return 'notFound'
  if (step.type !== 'tool-input-available') return 'notRunning'
  return 'unsupported'
}
