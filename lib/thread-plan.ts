/**
 * An Agent's live plan, from the run chunks the thread already holds (no new reads): the input of its newest plan call,
 * Claude Code's `TodoWrite` (`todos: { content, status }[]`) or Codex's `update_plan` (`plan: { step, status }[]`; the
 * daemon writes Codex's `turn/plan/updated` and Cursor's ACP `plan` updates as that call). Each call carries the whole
 * list, so the newest one is the plan; an empty one clears it.
 */
import { threadStepKind } from './issue-run-conversation'

export type ThreadPlanStatus = 'pending' | 'in_progress' | 'completed'
export type ThreadPlanItem = { id: string; text: string; status: ThreadPlanStatus }

const MAX_ITEMS = 50
const MAX_TEXT = 200

function status(value: unknown): ThreadPlanStatus {
  if (value === 'completed' || value === 'in_progress') return value
  return value === 'inProgress' ? 'in_progress' : 'pending'
}

function line(value: unknown) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/\s+/g, ' ')
  if (!text) return null
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** A plan call's items, or null when its input is not a plan (a malformed call leaves the last plan in place). */
function planItems(input: unknown): ThreadPlanItem[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const list = Array.isArray(record.todos) ? record.todos : Array.isArray(record.plan) ? record.plan : null
  if (!list) return null
  const items: ThreadPlanItem[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const text = line(item.content ?? item.step)
    // The id is its place and words: a change of state alone keeps the row, so it updates in place.
    if (text) items.push({ id: `${items.length}:${text}`, text, status: status(item.status) })
    if (items.length === MAX_ITEMS) break
  }
  return items
}

/**
 * The newest plan in a thread's chunks, or null. With `runId`, the chunks span several runs (chainChunks prefixes each
 * call's id with its run): only that run's calls count, so a new run shows no plan until it writes one.
 */
export function threadPlan(chunks: readonly { chunk: Record<string, unknown> }[], runId?: string): ThreadPlanItem[] | null {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index].chunk
    if (chunk.type !== 'tool-input-available' || typeof chunk.toolName !== 'string' || threadStepKind(chunk.toolName) !== 'todo') continue
    if (runId !== undefined && !String(chunk.toolCallId ?? '').startsWith(`${runId}:`)) continue
    const items = planItems(chunk.input)
    if (items) return items.length ? items : null
  }
  return null
}

/**
 * A run's plan from a thread read (app/actions/agents.ts): its chunks span several runs when the read's chain has more
 * than one, else they are one run's, which must be `runId`'s (a new run has no chunks of its own yet).
 */
export function runPlan(read: {
  chunks: readonly { chunk: Record<string, unknown> }[]
  chunkCursor?: { runs: number; runId: string | null } | null
  historyPage?: { chain: string } | null
}, runId: string): ThreadPlanItem[] | null {
  const chain = read.historyPage?.chain.split(',')
  const spans = chain ? chain.length > 1 : (read.chunkCursor?.runs ?? 0) > 1
  if (spans) return threadPlan(read.chunks, runId)
  const only = chain ? chain[0] : read.chunkCursor?.runId
  return only === runId ? threadPlan(read.chunks) : null
}
