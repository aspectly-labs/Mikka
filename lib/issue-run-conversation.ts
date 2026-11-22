import { credentialMasker, maskDeep } from './secrets/mask'
import { foldChunks } from './conversation/fold'
import { runScoped } from './conversation/ids'
import { interleave, type PersonMessage } from './conversation/interleave'
import type { ConversationMessage, ConversationPartMeta } from './conversation/model'

/** View helpers for the existing durable run chunk stream; no new session model. */
export function runIsActive(status: string) {
  return ['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(status)
}

/**
 * The agent is generating or running right now: the composer's button is stop.
 * A run waiting for the person's answer (`waiting_input`) is live but idle, so the
 * composer sends; stopping it stays in the thread header (usability review N1).
 */
export function runIsWorking(status: string) {
  return runIsActive(status) && status !== 'waiting_input'
}

/**
 * The status badge beside a run's activity line (「正在工作 · 18 分」, 「在等你回复」) only adds what the line does not
 * say: a working, waiting or stopping run is the line alone, as one running indicator in Claude, ChatGPT and LobeHub.
 */
export function activityLineBadgeShown(status: string, { waiting, stopping, outcome }: { waiting: boolean; stopping: boolean; outcome: unknown }) {
  if (stopping || waiting || runIsActive(status)) return false
  return status === 'failed' || status === 'paused' || outcome != null
}

/**
 * A run has one Stop. While it works and its composer is on screen, that is the composer's send button (and Esc,
 * decision 2026-11-22-1600); the header's stop stands in only where the composer cannot: a run waiting for an answer,
 * whose composer sends (N1), a reader without a composer, or another view of the thread (改动, 验收).
 */
export function headerStopShown({ canStop, working, composerStop }: { canStop: boolean; working: boolean; composerStop: boolean }) {
  return canStop && !(working && composerStop)
}

export const RUN_STOP_TIMEOUT_MS = 30_000

/** A persisted request retains its deadline across polling and reloads. */
export function runStopTimeoutRemaining(requestedAt: number, now = Date.now()) {
  return Math.max(0, Math.min(RUN_STOP_TIMEOUT_MS, requestedAt + RUN_STOP_TIMEOUT_MS - now))
}

export function runStatusKey(status: string) {
  switch (status) {
    case 'queued': case 'preparing': case 'running': case 'waiting_input': case 'finishing':
    case 'succeeded': case 'stopped': case 'failed': case 'cancelled': case 'paused': return status
    default: return null
  }
}

/** One line about what a finished run did: the report's summary, else the first line of its error. */
export function runSummaryText(run: { report: unknown; error: string | null }): string | null {
  return runSummaryView(run).summary
}

/** Preserve the display fallback while naming its source for proof consumers. */
export function runSummaryView(run: { report: unknown; error: string | null }): { summary: string | null; summarySource: 'report' | 'error' | null } {
  const report = run.report
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    const summary = (report as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary.trim()) return { summary: summary.trim(), summarySource: 'report' }
  }
  const summary = run.error?.split('\n').find(line => line.trim())?.trim() ?? null
  return { summary, summarySource: summary ? 'error' : null }
}

/**
 * Why a failed run failed, as stored on the run (masked when it was written,
 * PR #804): shown under its start-up stages so the thread says which stage
 * stopped and why. Nothing for a run that did not fail.
 */
export function runFailureText(status: string, error: string | null | undefined): string | null {
  if (status !== 'failed') return null
  const text = error?.trim()
  return text ? text : null
}

/** One start-up stage the daemon reported (`data-run-stage`): which, how long, whether it worked. */
export type ThreadStage = { stage: 'repository' | 'worktree' | 'agent_start'; ms: number; ok: boolean }
const THREAD_STAGES = new Set<ThreadStage['stage']>(['repository', 'worktree', 'agent_start'])

/**
 * What a tool call did, from its harness's tool name (#2937): the thread names a call by its kind and target
 * (「已读取 a.ts」) instead of parsing a summary. Unknown tools, MCP tools included, are `other`.
 */
export type ThreadStepKind = 'read' | 'search' | 'shell' | 'edit' | 'web' | 'delegate' | 'todo' | 'other'

/**
 * Where a call stands: `running` until its result arrives. A call still running when its run ended never finished;
 * `threadStepStatus` reads it as `cancelled`.
 */
export type ThreadStepStatus = 'running' | 'ok' | 'failed'

/**
 * One tool call in a folded "N steps" line: its name, the one input that says what it did, and whether it failed.
 * Structured (#2937): `kind`, `status`, `target` (the file, pattern, URL or query it acted on), `scope` (where a search
 * looked), and `outputTruncated` when the daemon kept only the end of the output. `output` is everything stored.
 */
export type ThreadStep = {
  id: string; name: string; detail: string | null; failed: boolean; command?: string; output?: string; exitCode?: number | null; ms?: number
  kind: ThreadStepKind; status: ThreadStepStatus; target?: string; scope?: string; outputTruncated?: true
}

/** Claude Code's, Codex's and Cursor's (ACP `kind`) tool names by kind; matched without case. */
const STEP_KINDS: Record<Exclude<ThreadStepKind, 'other'>, readonly string[]> = {
  read: ['read', 'notebookread', 'read_file', 'view', 'cat'],
  search: ['grep', 'glob', 'ls', 'search', 'find', 'file_search', 'codebase_search', 'list_dir'],
  shell: ['bash', 'shell', 'execute', 'exec_command', 'local_shell'],
  edit: ['edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'delete', 'move', 'write_file', 'edit_file', 'str_replace'],
  web: ['webfetch', 'websearch', 'web_search', 'fetch'],
  delegate: ['task', 'agent'],
  todo: ['todowrite', 'update_plan', 'taskcreate', 'taskupdate'],
}
const STEP_KIND_OF = new Map(Object.entries(STEP_KINDS).flatMap(([kind, names]) => names.map(name => [name, kind as ThreadStepKind])))

/** A tool name's kind (#2937). */
export function threadStepKind(name: string): ThreadStepKind {
  return STEP_KIND_OF.get(name.toLowerCase()) ?? 'other'
}

/** A call's status once its run is known: one left running by a run that ended was cancelled. */
export function threadStepStatus(step: Pick<ThreadStep, 'status'>, runActive: boolean): ThreadStepStatus | 'cancelled' {
  return step.status === 'running' && !runActive ? 'cancelled' : step.status
}

/** Claude Code's `Bash`, Codex's `bash`/`shell` and Cursor's `execute` run a command; every other step is a tool (as iOS
 * apps/mobile/features/tasks/model/thread-steps.ts counts them, #1770). */
export const isCommandStep = (step: Pick<ThreadStep, 'name'>) => threadStepKind(step.name) === 'shell'

/** Codex records its combined output and exit code in a single result. */
function commandResult(value: unknown) {
  if (value && typeof value === 'object' && 'output' in value && typeof value.output === 'string'
    && 'exitCode' in value && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))) {
    return { output: value.output, exitCode: value.exitCode }
  }
  return null
}

/** The terminal panel shows captured text. Other readers still receive the original result preview. */
export function threadStepOutput(step: Pick<ThreadStep, 'output' | 'exitCode'>) {
  const output = step.output
  if (!output || step.exitCode === undefined) return output
  try { return commandResult(JSON.parse(output))?.output ?? output } catch { return output }
}

/** A folded steps row's counts: 「已运行 2 条命令 · 调用了 1 个工具」. */
export function threadStepCounts(steps: readonly Pick<ThreadStep, 'name'>[]) {
  const commands = steps.filter(isCommandStep).length
  return { commands, tools: steps.length - commands }
}

const STEP_DETAIL_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'title', 'description'] as const
const STEP_DETAIL_MAX = 200
const STEP_OUTPUT_END_CHARS = 4096

/** Stored chunks already mask workspace/owner secrets; reapply credential patterns before cutting. */
function stepText(output: unknown): string | undefined {
  return stepTextCut(output)?.text
}

/** `stepText`, and whether it left out the middle. */
function stepTextCut(output: unknown): { text: string; cut: boolean } | undefined {
  if (output === undefined || output === null) return undefined
  const masked = maskDeep(output, credentialMasker)
  const text = typeof masked === 'string' ? masked : JSON.stringify(masked, null, 2)
  if (text === undefined) return undefined
  return text.length <= STEP_OUTPUT_END_CHARS * 2 ? { text, cut: false }
    : { text: `${text.slice(0, STEP_OUTPUT_END_CHARS)}\n[output truncated]\n${text.slice(-STEP_OUTPUT_END_CHARS)}`, cut: true }
}

const TARGET_KEYS: Partial<Record<ThreadStepKind, readonly string[]>> = {
  read: ['file_path', 'path', 'notebook_path', 'file'],
  search: ['pattern', 'query', 'glob', 'path'],
  edit: ['file_path', 'path', 'notebook_path', 'file'],
  web: ['url', 'query'],
  delegate: ['description', 'subagent_type'],
}

/** What a call acted on, and for a search where it looked (#2937). A path, pattern or URL is one line, cut at 200 characters. */
function stepTarget(kind: ThreadStepKind, input: unknown): { target?: string; scope?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const line = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const text = value.trim().replace(/\s+/g, ' ')
    return text.length > STEP_DETAIL_MAX ? `${text.slice(0, STEP_DETAIL_MAX - 1)}…` : text
  }
  const key = TARGET_KEYS[kind]?.find(name => line(record[name]))
  let target = key ? line(record[key]) : undefined
  if (!target && kind === 'edit' && Array.isArray(record.files)) target = line(record.files.filter(file => typeof file === 'string').join(', '))
  const scope = kind === 'search' && key !== 'path' ? line(record.path) : undefined
  return { ...(target ? { target } : {}), ...(scope ? { scope } : {}) }
}

function stepDetail(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  let detail: string | null = null
  for (const key of STEP_DETAIL_KEYS) if (typeof record[key] === 'string' && (record[key] as string).trim()) { detail = (record[key] as string).trim(); break }
  if (!detail && Array.isArray(record.files)) detail = record.files.filter(file => typeof file === 'string').join(', ') || null
  if (!detail) return null
  const line = detail.replace(/\s+/g, ' ')
  return line.length > STEP_DETAIL_MAX ? `${line.slice(0, STEP_DETAIL_MAX - 1)}…` : line
}

/**
 * A thread's chunks across its runs (R-81: an ended thread runs again in the same thread), as the conversation layer
 * keys them (lib/conversation/ids.ts): every chunk gets an id scoped to its run, from the first run on, so a second run
 * never renames the first one's ids. Stored chunks are not rewritten; the scope is added when they are read, and is
 * idempotent. A chunk with no id of its own (a stage, an error, a data part) gets `<runId>:#<seq>`, which also tells
 * the fold which run it belongs to. `spansRuns` is accepted for older callers and no longer changes anything.
 */
export function chainChunks<T extends { runId: string; chunk: Record<string, unknown>; at: Date | string; seq?: number }>(rows: readonly T[], _spansRuns?: boolean): { chunk: Record<string, unknown>; at: T['at'] }[] {
  const seen = new Map<string, number>()
  return rows.map(({ runId, chunk, at, seq }) => {
    const index = seen.get(runId) ?? 0
    seen.set(runId, index + 1)
    const scoped: Record<string, unknown> = { ...chunk }
    if (chunk.toolCallId !== undefined) scoped.toolCallId = runScoped(runId, String(chunk.toolCallId))
    if (chunk.id !== undefined) scoped.id = runScoped(runId, String(chunk.id))
    else if (chunk.toolCallId === undefined) scoped.id = runScoped(runId, `#${seq ?? index}`)
    return { at, chunk: scoped }
  })
}

/** A thread read with a chunk cursor: the chunks held plus the appended ones, or the read alone (lib/thread-chunks.ts). */
export function mergeThreadChunks<T extends { chunks: unknown[]; chunksAppend: boolean; promptOmitted?: true; thread?: { prompt: string; hasInstructions?: true } }>(held: T | undefined, read: T): T {
  if (!read.chunksAppend || !held) return read
  // A cursor read leaves out the run's prompt (it never changes): keep the one already held.
  const thread = read.promptOmitted && read.thread && held.thread ? { ...read.thread, prompt: held.thread.prompt, ...(held.thread.hasInstructions ? { hasInstructions: true as const } : {}) } : read.thread
  const { promptOmitted: _omitted, ...merged } = { ...read, chunks: [...held.chunks, ...read.chunks], ...(thread ? { thread } : {}) }
  return merged as T
}

export type ThreadItem =
  | { kind: 'agent'; id: string; text: string; at: number }
  | { kind: 'steps'; id: string; count: number; steps: ThreadStep[]; at: number }
  | { kind: 'error'; id: string; text: string; at: number }
  | { kind: 'stages'; id: string; stages: ThreadStage[]; at: number }
  | { kind: 'computer'; id: string; botId: string; runId: string; task: string; at: number }
  | { kind: 'person'; id: string; text: string; author: string; image?: string | null; mine: boolean; at: number }

/** A person's message in a thread (`run_messages`): keyed by the id the client minted when it sent it, else its own. */
export type ThreadPersonMessage = { id: string; submissionId?: string | null; text: string; author: string; image?: string | null; mine: boolean; at: Date | string }

/** The people's messages as the conversation layer orders them: the id their unsent bubble had, so nothing remounts. */
export function threadPeople(messages: readonly ThreadPersonMessage[]): PersonMessage[] {
  return messages.map(message => ({ id: message.submissionId ?? message.id, text: message.text, at: new Date(message.at).getTime(),
    author: { id: message.author, name: message.author, image: message.image, mine: message.mine }, source: message }))
}

/**
 * A thread as one conversation: the runs' chunks folded by the conversation layer (lib/conversation/fold.ts), people's
 * messages put in their place (lib/conversation/interleave.ts), consecutive tool calls folded into one "N steps" line.
 * The server's reads (the phone's thread, a fork's context) and the page's live updates go through the same fold.
 */
export async function threadItems(
  chunks: readonly { chunk: Record<string, unknown>; at: Date | string; runId?: string }[],
  messages: readonly ThreadPersonMessage[],
  expectedRunId?: string,
): Promise<ThreadItem[]> {
  return conversationItems(interleave(await foldChunks(chunks), threadPeople(messages)), expectedRunId)
}

type ToolLike = { type: string; toolCallId: string; toolName?: string; state: string; input?: unknown; output?: unknown; errorText?: string }

/** One tool part as a step. */
function toolStep(part: ToolLike, where: ConversationPartMeta | undefined): ThreadStep {
  const name = part.toolName || (part.type.startsWith('tool-') ? part.type.slice(5) : '') || 'tool'
  const kind = threadStepKind(name)
  const step: ThreadStep = { id: part.toolCallId, name, detail: stepDetail(part.input), failed: false, kind, status: 'running', ...stepTarget(kind, part.input) }
  if (isCommandStep(step) && part.input && typeof part.input === 'object' && 'command' in part.input && typeof part.input.command === 'string' && part.input.command.trim()) {
    step.command = stepText(part.input.command)
  }
  if (part.state === 'output-error') { step.failed = true; step.status = 'failed' }
  else if (part.state === 'output-available') {
    step.status = 'ok'
    if (where?.outputTruncated) step.outputTruncated = true
    const output = stepTextCut(part.output)
    if (output !== undefined) step.output = output.text
    if (output?.cut) step.outputTruncated = true
    const code = isCommandStep(step) ? commandResult(part.output)?.exitCode : undefined
    if (code !== undefined) {
      step.exitCode = code
      step.failed = code !== null && code !== 0
      if (step.failed) step.status = 'failed'
    }
  }
  // `at` is the batch's insert time, not tool execution time. Historical chunks stay unknown.
  if (part.state.startsWith('output') && where?.durationMs !== undefined) step.ms = where.durationMs
  return step
}

/** The conversation layer's messages as a thread's items (the thread's own rows; lib/thread-outline.ts reads them too). */
export function conversationItems(conversation: readonly ConversationMessage[], expectedRunId?: string): ThreadItem[] {
  const items: ThreadItem[] = []
  for (const message of conversation) {
    if (message.role === 'user') {
      const author = message.metadata?.author
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
      items.push({ kind: 'person', id: message.id, text, author: author?.name ?? '', image: author?.image, mine: author?.mine ?? true, at: message.metadata?.at ?? 0 })
      continue
    }
    let steps: Extract<ThreadItem, { kind: 'steps' }> | null = null
    let stages: Extract<ThreadItem, { kind: 'stages' }> | null = null
    for (const [index, part] of message.parts.entries()) {
      const where = message.metadata?.parts?.[index]
      const at = where?.at ?? message.metadata?.at ?? 0
      const id = where?.key.slice(where.key.indexOf(':') + 1) ?? `${message.id}#${index}`
      if (part.type === 'text') {
        if (!part.text.trim()) continue
        steps = null; stages = null
        items.push({ kind: 'agent', id: `text:${id}`, text: part.text, at })
      } else if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
        stages = null
        const step = toolStep(part as ToolLike, where)
        if (steps) { steps.count += 1; steps.steps.push(step) }
        else { steps = { kind: 'steps', id: `steps:${step.id}`, count: 1, steps: [step], at }; items.push(steps) }
      } else if (part.type === 'data-run-stage') {
        steps = null
        const data = part.data as Record<string, unknown>
        if (!THREAD_STAGES.has(data?.stage as ThreadStage['stage']) || typeof data.ms !== 'number' || typeof data.ok !== 'boolean') continue
        const stage: ThreadStage = { stage: data.stage as ThreadStage['stage'], ms: data.ms, ok: data.ok }
        if (stages) stages.stages.push(stage)
        else { stages = { kind: 'stages', id: `stages:${part.id ?? id}`, stages: [stage], at }; items.push(stages) }
      } else if (part.type === 'data-error') {
        steps = null; stages = null
        items.push({ kind: 'error', id: `error:${part.id ?? id}`, text: part.data.text, at })
      } else if (part.type === 'data-computer' && expectedRunId) {
        const data = part.data as Record<string, unknown>
        if (data?.runId === expectedRunId && typeof data.botId === 'string' && typeof data.task === 'string' && data.task.length <= 200 && !items.some(item => item.kind === 'computer' && item.runId === expectedRunId))
          items.push({ kind: 'computer', id: `computer:${expectedRunId}`, botId: data.botId, runId: expectedRunId, task: data.task, at })
      }
    }
  }
  return items
}
