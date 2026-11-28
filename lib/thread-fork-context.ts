import { threadItems, type ThreadItem } from './issue-run-conversation'
import type { RunChain, RunChainQueryable } from './run-chain'

/**
 * What a fork starts with (#2936, Figma 1318:2 sections 13 and 15): the source thread up to the chosen message.
 * `full` is the conversation itself, every person and Agent message and a line per tool group; `summary` is how each run
 * of it ended (status, report summary, last reply), as a continuation brief says it (lib/thread-continuation.ts), with no
 * model call. Both start with what the thread was first asked and end with what the fork is asked now.
 */
export type ForkMode = 'full' | 'summary'
/** Where the fork's context ends: a message of one run of the chain, as the thread view names it (ThreadItem.id). */
export type ForkPoint = { runId: string; itemId?: string | null }

/** Bounded like every dispatch note (lib/thread-continuation.ts). */
export const FORK_NOTE_MAX = 10_000
const ASK_MAX = 2_000
const HEADING = '## Forked thread'

type RunRow = { id: string; asked: string; status: string; stopReason: string | null; summary: string | null; lastReply: string | null; error: string | null }

/** The chain's runs up to the fork point, in chain order, with their rows; null when the point is not in the chain. */
async function runsUpTo(q: RunChainQueryable, ownerId: string, chain: RunChain, point: ForkPoint) {
  const index = chain.attempts.findIndex(attempt => attempt.runId === point.runId)
  if (index < 0) return null
  const ids = chain.attempts.slice(0, index + 1).map(attempt => attempt.runId)
  const { rows } = await q.query(`SELECT id::text, status, "stopReason", error, report->>'summary' AS summary, "lastReply",
      CASE WHEN "promptTaskStart">=0 AND "promptTaskLength" BETWEEN 0 AND length(prompt)-"promptTaskStart"::bigint
        THEN substr(prompt,"promptTaskStart"+1,"promptTaskLength") ELSE prompt END AS asked
    FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2`, [ids, ownerId])
  const byId = new Map(rows.map(row => [String(row.id), row as unknown as RunRow]))
  return ids.map(id => byId.get(id)).filter((row): row is RunRow => Boolean(row))
}

function line(item: ThreadItem): string | null {
  switch (item.kind) {
    case 'person': return `Person: ${item.text.trim()}`
    case 'agent': return `Agent: ${item.text.trim()}`
    case 'steps': return `Tools: ${item.steps.map(step => step.detail ? `${step.name} ${step.detail}` : step.name).join('; ')}`
    case 'error': return `Error: ${item.text.trim()}`
    default: return null
  }
}

/** Keeps the end, where the fork point is: the conversation's latest part matters most. */
function tail(text: string, max: number) {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`
}

const RUN_SCOPED_UUID_RE = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i

function resolveEffectivePoint(chain: RunChain, point: ForkPoint): ForkPoint {
  if (!point.itemId) return point
  const embedded = RUN_SCOPED_UUID_RE.exec(point.itemId)?.[1]?.toLowerCase()
  if (embedded && chain.attempts.some(attempt => attempt.runId.toLowerCase() === embedded)) {
    const matchedAttempt = chain.attempts.find(attempt => attempt.runId.toLowerCase() === embedded)!
    return { runId: matchedAttempt.runId, itemId: point.itemId.replace(`:${matchedAttempt.runId}:`, ':') }
  }
  return { ...point, itemId: point.itemId.replace(`:${point.runId}:`, ':') }
}

/**
 * The brief of the fork's first run, or null when the point is not a message of the owner's chain (an item id that
 * does not exist in its run included). The person's own instruction for the fork comes last.
 */
export async function forkNote(q: RunChainQueryable, ownerId: string, chain: RunChain, point: ForkPoint, mode: ForkMode, instruction: string): Promise<string | null> {
  const effective = resolveEffectivePoint(chain, point)
  let runs = await runsUpTo(q, ownerId, chain, effective)
  if (!runs?.length) return null
  const asked = runs[0].asked.trim().slice(0, ASK_MAX)
  const itemsByRun = new Map<string, ThreadItem[]>()
  const loadRunItems = async (runId: string) => {
    const cached = itemsByRun.get(runId)
    if (cached) return cached
    const loaded = await runItems(q, ownerId, runId)
    itemsByRun.set(runId, loaded)
    return loaded
  }
  const matchesItem = (item: ThreadItem, targetId: string) => item.id === targetId
  let cutoffRunId = effective.runId
  if (effective.itemId) {
    const targetItems = await loadRunItems(effective.runId)
    let foundIndex = targetItems.findIndex(item => matchesItem(item, effective.itemId!))
    if (foundIndex < 0) {
      // A caller anchored at `liveRunId` may pass an unscoped user-message id from an earlier attempt in the same chain.
      for (let i = runs.length - 2; i >= 0; i--) {
        const candidateRun = runs[i]
        const candidateItems = await loadRunItems(candidateRun.id)
        const normalized = effective.itemId.replace(`:${candidateRun.id}:`, ':')
        const idx = candidateItems.findIndex(item => matchesItem(item, normalized))
        if (idx >= 0) {
          cutoffRunId = candidateRun.id
          runs = runs.slice(0, i + 1)
          foundIndex = idx
          effective.itemId = normalized
          break
        }
      }
      if (foundIndex < 0) return null
    }
  }
  let body: string
  if (mode === 'summary') {
    body = runs.map((run, index) => [`Run ${index + 1}: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}`,
      run.summary ? `Summary: ${run.summary}` : null, run.error ? `Error: ${run.error.split('\n')[0]}` : null,
      run.lastReply ? `Last reply: ${run.lastReply}` : null].filter(Boolean).join('\n')).join('\n\n')
  } else {
    const lines: string[] = []
    for (const run of runs) {
      let items = await loadRunItems(run.id)
      if (run.id === cutoffRunId && effective.itemId) {
        const at = items.findIndex(item => matchesItem(item, effective.itemId!))
        if (at < 0) return null
        items = items.slice(0, at + 1)
      }
      lines.push(...items.map(line).filter((text): text is string => Boolean(text)))
    }
    body = lines.join('\n\n')
  }
  const head = [HEADING,
    'This thread is a fork of another thread of the same task, taken at a message the person chose. Continue from that point: check the files and `git status` first, since the work may have moved on after it, and do not repeat a push, a pull request or a message that already happened.',
    asked ? `What the thread was first asked:\n${asked}` : null].filter(Boolean).join('\n\n')
  const ask = `What to do now:\n${instruction.trim()}`
  const room = FORK_NOTE_MAX - head.length - ask.length - 64
  const label = mode === 'summary' ? 'How its runs ended up to that point:' : 'The conversation up to that point:'
  return [head, `${label}\n${tail(body, Math.max(0, room))}`, ask].join('\n\n')
}

/** One run's messages as the thread view lists them, so an item id from the view names the same message here. */
async function runItems(q: RunChainQueryable, ownerId: string, runId: string): Promise<ThreadItem[]> {
  const [{ rows: chunks }, { rows: messages }] = await Promise.all([
    q.query('SELECT c.chunk,c."createdAt" AS at FROM run_chunks c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=$2 WHERE c."runId"=$1 ORDER BY c.seq', [runId, ownerId]),
    q.query(`SELECT m.id::text, m.text, m."createdAt" AS at,
        (e.payload#>>'{threadSubmission,requestId}') AS "submissionId"
      FROM run_messages m
      JOIN agent_runs r ON r.id=m."runId" AND r."userId"=$2
      LEFT JOIN coordinator_events e
        ON e.id=m.id AND e."userId"=m."userId" AND e.kind='user_message'
      WHERE m."runId"=$1 AND length(trim(m.text)) > 0 ORDER BY m."createdAt", m.id`, [runId, ownerId]),
  ])
  return threadItems(chunks as { chunk: Record<string, unknown>; at: Date }[],
    messages.map(row => ({
      id: String(row.id),
      ...(row.submissionId ? { submissionId: String(row.submissionId) } : {}),
      text: String(row.text),
      author: '',
      mine: true,
      at: row.at as Date,
    })), runId)
}
