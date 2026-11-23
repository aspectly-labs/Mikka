/**
 * An Agent's live plan, from its run's chunks. Claude Code's `TodoWrite` (`todos: { content, status }[]`) and Codex's
 * `update_plan` (`plan: { step, status }[]`; the daemon writes Codex's `turn/plan/updated` and Cursor's ACP `plan`
 * updates as that call) carry the whole list: the newest replaces it, an empty one clears it. Claude Code's newer
 * `TaskCreate` / `TaskUpdate` build it one task at a time: a create adds its `subject` as pending, its output chunk
 * carries the id the CLI gave it (`planTask.id`, packages/daemon/src/adapters/claude.ts), and an update addresses that
 * id (`status`, `subject`; `deleted` removes it).
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

type Task = ThreadPlanItem & { taskId?: string }

/**
 * The plan in a run's chunks, folded oldest first, or null. With `runId`, the chunks span several runs (chainChunks
 * prefixes each call's id with its run): only that run's calls count, so a new run shows no plan until it writes one.
 */
export function threadPlan(chunks: readonly { chunk: Record<string, unknown> }[], runId?: string): ThreadPlanItem[] | null {
  let items: Task[] = []
  const created = new Map<string, Task>()
  for (const { chunk } of chunks) {
    const callId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : ''
    if (!callId || (runId !== undefined && !callId.startsWith(`${runId}:`))) continue
    if (chunk.type === 'tool-input-available' && typeof chunk.toolName === 'string') {
      const name = chunk.toolName.toLowerCase()
      const input = chunk.input && typeof chunk.input === 'object' ? chunk.input as Record<string, unknown> : {}
      if (name === 'taskcreate') {
        const text = line(input.subject)
        if (!text || items.length >= MAX_ITEMS) continue
        const task: Task = { id: `task:${callId}`, text, status: 'pending' }
        items.push(task)
        created.set(callId, task)
      } else if (name === 'taskupdate') {
        const task = typeof input.taskId === 'string' ? items.find(item => item.taskId === input.taskId) : undefined
        if (!task) continue
        if (input.status === 'deleted') { items = items.filter(item => item !== task); continue }
        if (input.status !== undefined) task.status = status(input.status)
        task.text = line(input.subject) ?? task.text
      } else if (threadStepKind(name) === 'todo') {
        const list = planItems(input)
        if (list) items = list
      }
    } else if (chunk.type === 'tool-output-available') {
      const task = created.get(callId)
      const planTask = chunk.planTask && typeof chunk.planTask === 'object' ? (chunk.planTask as { id?: unknown }).id : undefined
      if (task && typeof planTask === 'string') task.taskId = planTask
    } else if (chunk.type === 'tool-output-error') {
      const task = created.get(callId)
      if (task) items = items.filter(item => item !== task)
    }
  }
  return items.length ? items.map(({ id, text, status }) => ({ id, text, status })) : null
}
