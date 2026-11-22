import { credentialMasker, maskDeep } from './secrets/mask'

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
  todo: ['todowrite', 'update_plan'],
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
 * A thread's chunks across its runs (R-81: an ended thread runs again in the same thread). Each run numbers its own
 * text and tool calls, so ids are made per run before they meet in one conversation; one run keeps them as they are.
 */
export function chainChunks<T extends { runId: string; chunk: Record<string, unknown>; at: Date | string }>(rows: readonly T[], spansRuns = new Set(rows.map(row => row.runId)).size > 1): { chunk: Record<string, unknown>; at: T['at'] }[] {
  if (!spansRuns) return rows.map(({ chunk, at }) => ({ chunk, at }))
  return rows.map(({ runId, chunk, at }) => ({
    at,
    chunk: { ...chunk, ...(chunk.id !== undefined ? { id: `${runId}:${String(chunk.id)}` } : {}), ...(chunk.toolCallId !== undefined ? { toolCallId: `${runId}:${String(chunk.toolCallId)}` } : {}) },
  }))
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

/**
 * A thread as one conversation: the agent's replies from the durable chunk stream,
 * consecutive tool calls folded into one "N steps" line, and what people said, in time order.
 */
export function threadItems(
  chunks: readonly { chunk: Record<string, unknown>; at: Date | string }[],
  messages: readonly { id: string; text: string; author: string; image?: string | null; mine: boolean; at: Date | string }[],
  expectedRunId?: string,
): ThreadItem[] {
  const items: ThreadItem[] = []
  const texts = new Map<string, Extract<ThreadItem, { kind: 'agent' }>>()
  const calls = new Map<string, ThreadStep>()
  for (const [index, { chunk, at }] of chunks.entries()) {
    const time = new Date(at).getTime()
    const last = items[items.length - 1]
    if (chunk.type === 'text-delta') {
      const id = `text:${String(chunk.id ?? index)}`
      let item = texts.get(id)
      if (!item) { item = { kind: 'agent', id, text: '', at: time }; texts.set(id, item); items.push(item) }
      if (typeof chunk.delta === 'string') item.text += chunk.delta
    } else if (chunk.type === 'tool-input-available') {
      const name = typeof chunk.toolName === 'string' && chunk.toolName ? chunk.toolName : 'tool'
      const kind = threadStepKind(name)
      const step: ThreadStep = { id: String(chunk.toolCallId ?? index), name, detail: stepDetail(chunk.input), failed: false, kind, status: 'running', ...stepTarget(kind, chunk.input) }
      if (isCommandStep(step) && chunk.input && typeof chunk.input === 'object' && 'command' in chunk.input && typeof chunk.input.command === 'string' && chunk.input.command.trim()) {
        step.command = stepText(chunk.input.command)
      }
      calls.set(step.id, step)
      if (last?.kind === 'steps') { last.count += 1; last.steps.push(step) }
      else items.push({ kind: 'steps', id: `steps:${index}`, count: 1, steps: [step], at: time })
    } else if ((chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') && typeof chunk.toolCallId === 'string') {
      const step = calls.get(chunk.toolCallId)
      if (step) {
        step.status = 'ok'
        if (chunk.type === 'tool-output-error') { step.failed = true; step.status = 'failed' }
        else {
          if (chunk.outputTruncated === true) step.outputTruncated = true
          const output = stepTextCut(chunk.output)
          if (output !== undefined) step.output = output.text
          if (output?.cut) step.outputTruncated = true
          const code = isCommandStep(step) ? commandResult(chunk.output)?.exitCode : undefined
          if (code !== undefined) {
            step.exitCode = code
            step.failed = code !== null && code !== 0
            if (step.failed) step.status = 'failed'
          }
        }
        // `at` is the batch's insert time, not tool execution time. Historical chunks stay unknown.
        if (typeof chunk.toolDurationMs === 'number' && Number.isFinite(chunk.toolDurationMs) && chunk.toolDurationMs >= 0) step.ms = chunk.toolDurationMs
      }
    } else if (chunk.type === 'data-computer' && expectedRunId && chunk.data && typeof chunk.data === 'object') {
      const data = chunk.data as Record<string, unknown>
      if (data.runId === expectedRunId && typeof data.botId === 'string' && typeof data.task === 'string' && data.task.length <= 200 && !items.some(item => item.kind === 'computer' && item.runId === expectedRunId))
        items.push({ kind: 'computer', id: `computer:${expectedRunId}`, botId: data.botId, runId: expectedRunId, task: data.task, at: time })
    } else if (chunk.type === 'data-run-stage' && chunk.data && typeof chunk.data === 'object') {
      const data = chunk.data as Record<string, unknown>
      if (THREAD_STAGES.has(data.stage as ThreadStage['stage']) && typeof data.ms === 'number' && typeof data.ok === 'boolean') {
        const stage: ThreadStage = { stage: data.stage as ThreadStage['stage'], ms: data.ms, ok: data.ok }
        if (last?.kind === 'stages') last.stages.push(stage)
        else items.push({ kind: 'stages', id: `stages:${index}`, stages: [stage], at: time })
      }
    } else if (chunk.type === 'error' && typeof chunk.errorText === 'string') {
      items.push({ kind: 'error', id: `error:${index}`, text: chunk.errorText, at: time })
    }
  }
  for (const message of messages) items.push({ kind: 'person', id: message.id, text: message.text, author: message.author, image: message.image, mine: message.mine, at: new Date(message.at).getTime() })
  return items.filter(item => item.kind !== 'agent' || item.text.trim()).sort((a, b) => a.at - b.at)
}
