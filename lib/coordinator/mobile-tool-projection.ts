// Codex Electron 1:1 Tool-Use projection for Bot chats (/api/mobile/chat) and
// Agent threads (/api/mobile/threads/[id]). Pure, non-mutating, bounded by length
// only (no regex secret masking or UUID scrubbing — mirrors Codex/Cursor/Claude).
import type { ChatItem, ChatTool } from '@/lib/coordinator/context'
import { toolAction, toolFailure } from '@/lib/coordinator/tool-activity'
import { previewFields } from '@/lib/coordinator/tool-detail'
import { DYNAMIC_TOOL_NAMES } from '@/lib/coordinator/tool-metadata'
import type { ThreadItem, ThreadStep } from '@/lib/issue-run-conversation'

export type CodexToolKind =
  | 'read'
  | 'search'
  | 'listFiles'
  | 'exec'
  | 'edit'
  | 'mcp'
  | 'web'
  | 'agent'
  | 'think'
  | 'other'

export type CodexToolStatus = 'running' | 'completed' | 'failed' | 'declined'

export type CodexCommandAction =
  | { type: 'read'; command: string; name?: string; path?: string }
  | { type: 'listFiles'; command: string; path?: string }
  | { type: 'search'; command: string; query?: string; path?: string }
  | { type: 'unknown'; command: string }

export type CodexFileChangeKind = 'add' | 'update' | 'delete'

export type CodexFileChange = {
  path: string
  changeKind: CodexFileChangeKind
  linesAdded?: number
  linesRemoved?: number
  diff?: string
}

export type CodexAgentAction = 'spawn' | 'message' | 'wait' | 'stop' | 'other'

export type CodexToolProjectionFields = {
  kind: CodexToolKind
  status: CodexToolStatus
  interrupted?: true
  command?: string
  cwd?: string
  commandActions?: CodexCommandAction[]
  exitCode?: number | null
  aggregatedOutput?: string
  durationMs?: number
  startedAtMs?: number
  completedAtMs?: number
  path?: string
  query?: string
  url?: string
  fileChange?: CodexFileChange
  fileChanges?: CodexFileChange[]
  server?: string
  tool?: string
  agentAction?: CodexAgentAction
  targetThreadId?: string
  arguments?: unknown
  result?: unknown
  error?: string
  detail?: string
}

export type MobileChatTool = ChatTool & CodexToolProjectionFields

export type MobileThreadStep = Omit<ThreadStep, 'kind' | 'status'> &
  Omit<CodexToolProjectionFields, 'detail'> & {
    detail: string | null
  }

export type MobileThreadItem =
  | Exclude<ThreadItem, { kind: 'steps' }>
  | (Omit<Extract<ThreadItem, { kind: 'steps' }>, 'steps'> & { steps: MobileThreadStep[] })

export type ThreadStepChunkContext = {
  startedAtMs?: number
  completedAtMs?: number
  cwd?: string
  rawInput?: unknown
  rawCommand?: string
  errorText?: string
}

export type EnrichMobileThreadOptions = {
  /** Whether the thread's latest run is currently active; steps still running on an ended run are marked interrupted. */
  active?: boolean
  /** Per-toolCallId metadata extracted from raw run chunks (`extractThreadStepContext`). */
  contextByCallId?: ReadonlyMap<string, ThreadStepChunkContext>
}

const MAX_COMMAND_CHARS = 2000
const MAX_OUTPUT_CHARS = 8192
const MAX_OUTPUT_HALF_CHARS = 4096
const MAX_DIFF_CHARS = 8192
const MAX_DETAIL_CHARS = 200
const MAX_ERROR_CHARS = 1000
const MAX_JSON_STRING_CHARS = 1024
const MAX_JSON_KEYS = 24
const MAX_JSON_ITEMS = 20
const MAX_JSON_DEPTH = 4

const SHELL_NAMES = new Set([
  'bash', 'shell', 'execute', 'exec_command', 'execute_command', 'local_shell', 'run_command', 'terminal', 'command', 'computer_shell',
])
const READ_NAMES = new Set(['read', 'read_file', 'view', 'view_file', 'notebookread', 'cat', 'image_view', 'view_image'])
const LIST_NAMES = new Set(['ls', 'list_dir', 'list_files', 'find_by_name', 'glob', 'directory_tree'])
const SEARCH_NAMES = new Set([
  'grep', 'grep_search', 'search', 'find', 'file_search', 'codebase_search',
  'find_repository', 'list_issues', 'get_issue', 'list_runs', 'get_run',
  'search_gmail', 'read_gmail_message', 'mailbox_inbox', 'mailbox_sent',
  'search_slack_messages', 'read_slack_thread', 'search_notion_pages', 'read_notion_page_blocks',
  'list_calendar_events', 'get_calendar_event', 'list_drive_files',
])
const EDIT_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'delete', 'delete_file', 'remove_file',
  'move', 'move_file', 'rename_file', 'write_file', 'create_file', 'edit_file', 'str_replace',
])
const WEB_NAMES = new Set(['webfetch', 'websearch', 'web_search', 'read_webpage', 'start_web_subagent', 'fetch'])
const AGENT_NAMES = new Set([
  'task', 'agent', 'spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'wait',
  'close_agent', 'interrupt_agent', 'send_message', 'followup_task',
  'dispatch_run', 'dispatch_bot_computer', 'dispatch_factory_run', 'dispatch_factory_task',
  'wake_bot_computer', 'send_to_run', 'stop_run', 'stop_factory_task',
])
const THINK_NAMES = new Set(['reasoning', 'think', 'todowrite', 'update_plan', 'plan', 'taskcreate', 'taskupdate'])
const MIKKA_MCP_ACTIONS = new Set([
  'createIssue', 'updateIssue', 'sendMail', 'sendSlack', 'writeNotion', 'writeCalendar',
  'remember', 'forget', 'schedule', 'factory', 'github',
])

const READ_SHELL_CMDS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more', 'wc', 'sed', 'awk'])
const LIST_SHELL_CMDS = new Set(['ls', 'tree', 'eza', 'exa', 'll', 'la', 'find'])
const SEARCH_SHELL_CMDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd'])
const SAFE_PIPE_FILTERS = new Set([
  'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'nl', 'cat', 'column', 'less', 'more', 'jq',
])

const DECLINED_PATTERN = /\b(?:declined|denied|rejected|permission_denied|approval_denied|user_rejected|policy_denied)\b/i

function truncateEnd(value: string, limit: number): string {
  const chars = Array.from(value)
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : value
}

function truncateMiddle(value: string, limit = MAX_OUTPUT_CHARS): string {
  if (value.length <= limit) return value
  const half = Math.min(MAX_OUTPUT_HALF_CHARS, Math.floor((limit - 20) / 2))
  return `${value.slice(0, half)}\n[output truncated]\n${value.slice(-half)}`
}

function nonEmptyString(value: unknown, limit = MAX_DETAIL_CHARS, collapseWhitespace = true): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = collapseWhitespace ? value.replace(/\s+/g, ' ').trim() : value.trim()
  if (!text) return undefined
  return truncateEnd(text, limit)
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function validDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

function validTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined
  }
  return undefined
}

function validExitCode(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value)) return value
  return undefined
}

function basenameOf(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  return idx >= 0 ? clean.slice(idx + 1) : clean
}

function boundValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return truncateEnd(value, MAX_JSON_STRING_CHARS)
  if (depth >= MAX_JSON_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '[object]'
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_JSON_ITEMS).map(item => boundValue(item, depth + 1))
    if (value.length > MAX_JSON_ITEMS) out.push(`… +${value.length - MAX_JSON_ITEMS} more`)
    return out
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const out: Record<string, unknown> = {}
    for (const [key, entry] of entries.slice(0, MAX_JSON_KEYS)) {
      if (entry !== undefined) out[key] = boundValue(entry, depth + 1)
    }
    return out
  }
  return undefined
}

function parseBoundedPayload(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return boundValue(raw)
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return boundValue(JSON.parse(trimmed))
    } catch {
      const partial = previewFields(trimmed)
      if (Object.keys(partial).length > 0) return boundValue(partial)
    }
  }
  return truncateMiddle(trimmed, MAX_OUTPUT_CHARS)
}

function dynamicOperation(name: string, inputFields: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(DYNAMIC_TOOL_NAMES, name)) return undefined
  const field = DYNAMIC_TOOL_NAMES[name as keyof typeof DYNAMIC_TOOL_NAMES].field
  const raw = inputFields[field]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function effectiveArgs(name: string, inputFields: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(DYNAMIC_TOOL_NAMES, name)) return inputFields
  const nested = recordOf(inputFields.arguments)
  return Object.keys(nested).length ? nested : inputFields
}

function parseMcpName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (!match) return undefined
  return { server: match[1], tool: match[2] }
}

/** Strips outer shell invocation wrappers such as `/bin/zsh -lc '...'` without redacting content. */
export function unwrapShellCommand(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const wrapper = /^(?:\/usr\/bin\/env\s+)?(?:(?:\/[^\s/]+)*\/)?(?:ba|z|da|a|k)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\s+([\s\S]+)$/.exec(trimmed)
  if (!wrapper) return truncateEnd(trimmed, MAX_COMMAND_CHARS)
  const payload = wrapper[1].trim()
  if (payload.length >= 2 && payload.startsWith("'") && payload.endsWith("'")) {
    const inner = payload.slice(1, -1)
    if (!inner.replace(/'\\''/g, '').includes("'")) {
      return truncateEnd(inner.replace(/'\\''/g, "'").trim(), MAX_COMMAND_CHARS)
    }
  }
  if (payload.length >= 2 && payload.startsWith('"') && payload.endsWith('"')) {
    const inner = payload.slice(1, -1)
    if (!inner.replace(/\\./g, '').includes('"')) {
      return truncateEnd(inner.replace(/\\(["\\$`])/g, '$1').trim(), MAX_COMMAND_CHARS)
    }
  }
  return truncateEnd(payload, MAX_COMMAND_CHARS)
}

/** Splits a shell command string into top-level tokens respecting quotes and escapes. */
function tokenizeShell(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) { current += ch; escaped = false; continue }
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\') escaped = true
      else current += ch
      continue
    }
    if (ch === '\\') { escaped = true; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

/** Splits on top-level operators (`&&`, `||`, `;`, or `|`) outside quotes. */
function splitShellTopLevel(command: string, mode: 'chain' | 'pipe'): string[] {
  const parts: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]
    if (escaped) { current += ch; escaped = false; continue }
    if (quote === "'") {
      current += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      current += ch
      if (ch === '"') quote = null
      else if (ch === '\\') escaped = true
      continue
    }
    if (ch === '\\') { current += ch; escaped = true; continue }
    if (ch === "'" || ch === '"') { current += ch; quote = ch; continue }
    if (mode === 'chain') {
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim())
        current = ''
        continue
      }
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (current.trim()) parts.push(current.trim())
        current = ''
        i++
        continue
      }
    } else if (ch === '|' && next !== '|' && command[i - 1] !== '|') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** True when a command segment contains a file-writing redirection outside quotes (ignoring `2>&1` and `2>/dev/null`). */
function hasWriteRedirect(segment: string): boolean {
  let quote: "'" | '"' | null = null
  let escaped = false
  let stripped = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (escaped) { escaped = false; continue }
    if (quote === "'") { if (ch === "'") quote = null; continue }
    if (quote === '"') { if (ch === '"') quote = null; else if (ch === '\\') escaped = true; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    stripped += ch
  }
  const withoutSafeStderr = stripped.replace(/\b2>&1\b/g, '').replace(/\b2>\s*\/dev\/null\b/g, '')
  return /(?:>>?|&>|<>)/.test(withoutSafeStderr)
}

function stripEnvAssignments(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++
  return tokens.slice(index)
}

function extractCommandArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): { positionals: string[]; flagValues: Map<string, string> } {
  const positionals: string[] = []
  const flagValues = new Map<string, string>()
  let afterDoubleDash = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (afterDoubleDash) { positionals.push(token); continue }
    if (token === '--') { afterDoubleDash = true; continue }
    if (token.startsWith('-') && token.length > 1) {
      const eqIdx = token.indexOf('=')
      if (eqIdx > 0) {
        flagValues.set(token.slice(0, eqIdx), token.slice(eqIdx + 1))
        continue
      }
      if (valueFlags.has(token) && i + 1 < args.length) {
        flagValues.set(token, args[++i])
      }
      continue
    }
    positionals.push(token)
  }
  return { positionals, flagValues }
}

function classifySingleStage(stage: string): { action: CodexCommandAction; safePipeTail: boolean; cdDir?: string } {
  const tokens = stripEnvAssignments(tokenizeShell(stage))
  if (!tokens.length || hasWriteRedirect(stage)) {
    return { action: { type: 'unknown', command: stage }, safePipeTail: false }
  }
  const cmd = basenameOf(tokens[0]).toLowerCase()
  const rest = tokens.slice(1)

  if (cmd === 'cd') {
    const target = rest.find(t => !t.startsWith('-'))
    return { action: { type: 'unknown', command: stage }, safePipeTail: false, cdDir: target }
  }

  if (cmd === 'git') {
    const sub = rest[0]?.toLowerCase()
    if (sub === 'ls-files') {
      const { positionals } = extractCommandArgs(rest.slice(1), new Set(['-x', '--exclude']))
      const path = positionals[0]
      return { action: { type: 'listFiles', command: stage, ...(path ? { path } : {}) }, safePipeTail: false }
    }
    if (sub === 'grep') {
      const { positionals, flagValues } = extractCommandArgs(rest.slice(1), new Set(['-e', '-C', '-A', '-B', '-m', '--max-depth', '-f']))
      const query = flagValues.get('-e') ?? positionals[0]
      const path = flagValues.has('-e') ? positionals[0] : positionals[1]
      return { action: { type: 'search', command: stage, ...(query ? { query } : {}), ...(path ? { path } : {}) }, safePipeTail: false }
    }
    return { action: { type: 'unknown', command: stage }, safePipeTail: false }
  }

  if (cmd === 'sed') {
    if (rest.some(flag => /^-[^-]*i/.test(flag) || flag === '--in-place' || flag.startsWith('--in-place='))) {
      return { action: { type: 'unknown', command: stage }, safePipeTail: false }
    }
    const { positionals, flagValues } = extractCommandArgs(rest, new Set(['-e', '-f']))
    const hasExprFlag = flagValues.has('-e') || flagValues.has('-f')
    const path = hasExprFlag ? positionals[0] : positionals[1]
    const name = path ? basenameOf(path) : undefined
    return { action: { type: 'read', command: stage, ...(name ? { name } : {}), ...(path ? { path } : {}) }, safePipeTail: true }
  }

  if (cmd === 'awk') {
    if (rest.some(flag => flag === '-i' || flag.startsWith('-i'))) {
      return { action: { type: 'unknown', command: stage }, safePipeTail: false }
    }
    const { positionals, flagValues } = extractCommandArgs(rest, new Set(['-F', '-v', '-f']))
    const path = flagValues.has('-f') ? positionals[0] : positionals[1]
    const name = path ? basenameOf(path) : undefined
    return { action: { type: 'read', command: stage, ...(name ? { name } : {}), ...(path ? { path } : {}) }, safePipeTail: true }
  }

  if (READ_SHELL_CMDS.has(cmd)) {
    const { positionals } = extractCommandArgs(rest, new Set(['-n', '-c', '-b', '-w', '-s', '-l', '--lines', '--bytes']))
    const path = positionals[0]
    const name = path ? basenameOf(path) : undefined
    return { action: { type: 'read', command: stage, ...(name ? { name } : {}), ...(path ? { path } : {}) }, safePipeTail: SAFE_PIPE_FILTERS.has(cmd) }
  }

  if (cmd === 'find') {
    if (rest.some(flag => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls'].includes(flag))) {
      return { action: { type: 'unknown', command: stage }, safePipeTail: false }
    }
    const path = rest.find(t => !t.startsWith('-') && t !== '!' && t !== '(' && t !== ')')
    return { action: { type: 'listFiles', command: stage, ...(path ? { path } : {}) }, safePipeTail: false }
  }

  if (LIST_SHELL_CMDS.has(cmd)) {
    const { positionals } = extractCommandArgs(rest, new Set(['-L', '-I', '-P', '-T', '--ignore']))
    const path = positionals[0]
    return { action: { type: 'listFiles', command: stage, ...(path ? { path } : {}) }, safePipeTail: false }
  }

  if (cmd === 'rg' && rest.includes('--files')) {
    const { positionals } = extractCommandArgs(rest, new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '--max-depth', '-d']))
    const path = positionals[0]
    return { action: { type: 'listFiles', command: stage, ...(path ? { path } : {}) }, safePipeTail: false }
  }

  if (cmd === 'fd') {
    const { positionals } = extractCommandArgs(rest, new Set(['-e', '--extension', '-t', '--type', '-d', '--max-depth', '-E', '--exclude', '-c', '--color']))
    if (positionals.length === 0) {
      return { action: { type: 'listFiles', command: stage }, safePipeTail: false }
    }
    const [query, path] = positionals
    return { action: { type: 'search', command: stage, ...(query ? { query } : {}), ...(path ? { path } : {}) }, safePipeTail: false }
  }

  if (SEARCH_SHELL_CMDS.has(cmd)) {
    const { positionals, flagValues } = extractCommandArgs(
      rest,
      new Set(['-e', '-f', '-g', '--glob', '-t', '--type', '-T', '--type-not', '-C', '-A', '-B', '-m', '--max-count', '--max-depth', '--include', '--exclude', '--exclude-dir']),
    )
    const query = flagValues.get('-e') ?? positionals[0]
    const path = flagValues.has('-e') ? positionals[0] : positionals[1]
    return { action: { type: 'search', command: stage, ...(query ? { query } : {}), ...(path ? { path } : {}) }, safePipeTail: SAFE_PIPE_FILTERS.has(cmd) }
  }

  return { action: { type: 'unknown', command: stage }, safePipeTail: SAFE_PIPE_FILTERS.has(cmd) }
}

/** Classifies a shell command into Codex `CommandAction[]` and determines if it is pure exploration (`read`/`search`/`listFiles`) or `exec`. */
export function classifyShellCommand(rawCommand: string): {
  kind: 'read' | 'search' | 'listFiles' | 'exec'
  command: string
  commandActions: CodexCommandAction[]
  inferredCwd?: string
  path?: string
  query?: string
} {
  const command = unwrapShellCommand(rawCommand)
  if (!command) return { kind: 'exec', command: '', commandActions: [] }

  const segments = splitShellTopLevel(command, 'chain')
  const actions: CodexCommandAction[] = []
  let inferredCwd: string | undefined

  for (const segment of segments) {
    const pipeStages = splitShellTopLevel(segment, 'pipe')
    if (!pipeStages.length) continue
    const first = classifySingleStage(pipeStages[0])
    if (pipeStages.length === 1 && first.cdDir && segments.length > 1) {
      inferredCwd = first.cdDir
      continue
    }
    if (pipeStages.length === 1) {
      actions.push(first.action)
      continue
    }
    // Pipeline: only exploration if stage 0 is exploration AND every downstream stage is a safe read-only filter.
    const tails = pipeStages.slice(1).map(classifySingleStage)
    const allSafeTails = tails.every(stage => stage.safePipeTail)
    if (first.action.type !== 'unknown' && allSafeTails) {
      const searchTail = tails.find(stage => stage.action.type === 'search')
      if (searchTail && searchTail.action.type === 'search') {
        actions.push({
          type: 'search',
          command: segment,
          ...(searchTail.action.query ? { query: searchTail.action.query } : {}),
          ...('path' in first.action && first.action.path ? { path: first.action.path } : {}),
        })
      } else {
        actions.push({ ...first.action, command: segment })
      }
    } else {
      actions.push({ type: 'unknown', command: segment })
    }
  }

  if (!actions.length) actions.push({ type: 'unknown', command })
  const isPureExploration = actions.every(action => action.type !== 'unknown')
  const firstAction = actions[0]
  const kind: 'read' | 'search' | 'listFiles' | 'exec' = isPureExploration && firstAction.type !== 'unknown'
    ? firstAction.type
    : 'exec'
  const path = firstAction && 'path' in firstAction ? firstAction.path : undefined
  const query = firstAction && firstAction.type === 'search' ? firstAction.query : undefined

  return {
    kind,
    command,
    commandActions: actions,
    ...(inferredCwd ? { inferredCwd } : {}),
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
  }
}

function countLineDiff(oldText: string, newText: string): { linesAdded: number; linesRemoved: number; diff: string } {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n')
  const newLines = newText.length === 0 ? [] : newText.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  const diffLines = [...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)]
  return {
    linesAdded: added.length,
    linesRemoved: removed.length,
    diff: truncateEnd(diffLines.join('\n'), MAX_DIFF_CHARS),
  }
}

function parsePatchText(patchText: string): CodexFileChange[] {
  const changes: CodexFileChange[] = []
  const lines = patchText.split('\n')
  let current: { path: string; changeKind: CodexFileChangeKind; added: number; removed: number; lines: string[] } | null = null

  const flush = () => {
    if (!current) return
    changes.push({
      path: current.path,
      changeKind: current.changeKind,
      linesAdded: current.added,
      linesRemoved: current.removed,
      ...(current.lines.length ? { diff: truncateEnd(current.lines.join('\n'), MAX_DIFF_CHARS) } : {}),
    })
    current = null
  }

  for (const line of lines) {
    const codexFile = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (codexFile) {
      flush()
      const kindMap: Record<string, CodexFileChangeKind> = { Add: 'add', Update: 'update', Delete: 'delete' }
      current = { path: codexFile[2].trim(), changeKind: kindMap[codexFile[1]], added: 0, removed: 0, lines: [] }
      continue
    }
    const codexMove = /^\*\*\* Move to: (.+)$/.exec(line)
    if (codexMove && current) {
      current.path = codexMove[1].trim()
      continue
    }
    const gitDiff = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (gitDiff) {
      flush()
      current = { path: gitDiff[2].trim(), changeKind: 'update', added: 0, removed: 0, lines: [] }
      continue
    }
    if (current) {
      if (line.startsWith('new file mode ')) { current.changeKind = 'add'; continue }
      if (line.startsWith('deleted file mode ')) { current.changeKind = 'delete'; continue }
      if (line === '*** End Patch' || line === '*** End of File') continue
      if (line.startsWith('+++') || line.startsWith('---')) {
        if (line.startsWith('--- /dev/null')) current.changeKind = 'add'
        else if (line.startsWith('+++ /dev/null')) current.changeKind = 'delete'
        continue
      }
      if (line.startsWith('+')) { current.added++; current.lines.push(line) }
      else if (line.startsWith('-')) { current.removed++; current.lines.push(line) }
      else if (line.startsWith('@@') || line.startsWith(' ')) { current.lines.push(line) }
    }
  }
  flush()
  return changes
}

function extractFileChanges(
  name: string,
  args: Record<string, unknown>,
  rawOutput: string | undefined,
  fallbackTarget?: string,
  rawInputText?: string,
): CodexFileChange[] {
  const lower = name.toLowerCase()
  const patchText = [rawInputText, args.patch, args.input, args.diff, rawOutput].find(
    (v): v is string => typeof v === 'string' && (v.includes('*** ') || v.includes('diff --git ')),
  )
  if (patchText) {
    const parsed = parsePatchText(patchText)
    if (parsed.length > 0) return parsed
  }

  const path = nonEmptyString(
    args.file_path ?? args.path ?? args.Path ?? args.TargetFile ?? args.notebook_path ?? args.file ?? args.destination ?? args.to ?? fallbackTarget,
    400,
    false,
  )
  if (!path) return []

  if (lower.includes('delete') || lower.includes('remove')) {
    return [{ path, changeKind: 'delete' }]
  }

  if (Array.isArray(args.edits)) {
    let linesAdded = 0
    let linesRemoved = 0
    const diffParts: string[] = []
    for (const edit of args.edits) {
      const rec = recordOf(edit)
      const oldText = typeof rec.old_string === 'string' ? rec.old_string : typeof rec.old_str === 'string' ? rec.old_str : undefined
      const newText = typeof rec.new_string === 'string' ? rec.new_string : typeof rec.new_str === 'string' ? rec.new_str : undefined
      if (oldText !== undefined && newText !== undefined) {
        const computed = countLineDiff(oldText, newText)
        linesAdded += computed.linesAdded
        linesRemoved += computed.linesRemoved
        if (computed.diff) diffParts.push(computed.diff)
      }
    }
    return [{
      path,
      changeKind: 'update',
      linesAdded,
      linesRemoved,
      ...(diffParts.length ? { diff: truncateEnd(diffParts.join('\n...\n'), MAX_DIFF_CHARS) } : {}),
    }]
  }

  const oldText = typeof args.old_string === 'string' ? args.old_string
    : typeof args.old_str === 'string' ? args.old_str
    : typeof args.Target === 'string' ? args.Target
    : undefined
  const newText = typeof args.new_string === 'string' ? args.new_string
    : typeof args.new_str === 'string' ? args.new_str
    : typeof args.Replacement === 'string' ? args.Replacement
    : undefined
  if (oldText !== undefined && newText !== undefined) {
    const computed = countLineDiff(oldText, newText)
    return [{
      path,
      changeKind: 'update',
      linesAdded: computed.linesAdded,
      linesRemoved: computed.linesRemoved,
      ...(computed.diff ? { diff: computed.diff } : {}),
    }]
  }

  const content = typeof args.content === 'string' ? args.content
    : typeof args.Content === 'string' ? args.Content
    : typeof args.new_source === 'string' ? args.new_source
    : undefined
  if (lower === 'write' || lower === 'write_file' || lower === 'create_file') {
    const linesAdded = content !== undefined ? (content.length === 0 ? 0 : content.split('\n').length) : undefined
    return [{
      path,
      changeKind: args.overwrite === true ? 'update' : 'add',
      ...(linesAdded !== undefined ? { linesAdded, linesRemoved: 0 } : {}),
    }]
  }

  return [{ path, changeKind: 'update' }]
}

function isShellToolName(lower: string): boolean {
  return SHELL_NAMES.has(lower) || /(?:^|_)(?:shell|bash|exec|terminal|run_command)(?:$|_)/.test(lower)
}

function extractRawShellCommand(args: Record<string, unknown>, fallbackCommand?: string, allowScript = true): string | undefined {
  const keys = allowScript ? (['command', 'cmd', 'script'] as const) : (['command', 'cmd'] as const)
  for (const key of keys) {
    const raw = args[key]
    if (typeof raw === 'string' && raw.trim()) return raw
  }
  return fallbackCommand?.trim() ? fallbackCommand : undefined
}

function extractCwd(args: Record<string, unknown>, fallbackCwd?: string): string | undefined {
  return nonEmptyString(args.cwd ?? args.workdir ?? args.working_directory ?? args.dir ?? fallbackCwd, 400, false)
}

function classifyAgentAction(name: string): CodexAgentAction {
  const lower = name.toLowerCase()
  if (lower.includes('stop') || lower.includes('close') || lower.includes('interrupt')) return 'stop'
  if (lower.includes('wait')) return 'wait'
  if (lower.includes('send') || lower.includes('message') || lower.includes('followup')) return 'message'
  if (lower.includes('dispatch') || lower.includes('spawn') || lower.includes('wake') || lower === 'task' || lower === 'agent') return 'spawn'
  return 'other'
}

function classifyNonShellKind(name: string, inputFields: Record<string, unknown>): CodexToolKind {
  const lower = name.toLowerCase()
  if (parseMcpName(name)) return 'mcp'
  if (name === 'call_personal_mcp_tool' || name === 'call_app_tool' || name === 'github_call' || name === 'github_tools') return 'mcp'
  if (AGENT_NAMES.has(lower)) return 'agent'
  if (THINK_NAMES.has(lower)) return 'think'
  if (EDIT_NAMES.has(lower)) return 'edit'
  if (WEB_NAMES.has(lower)) return 'web'
  if (READ_NAMES.has(lower)) return 'read'
  if (LIST_NAMES.has(lower)) return 'listFiles'
  if (SEARCH_NAMES.has(lower)) return 'search'

  const action = toolAction(name)
  if (action === 'dispatch' || action === 'dispatchFactory' || action === 'wake' || action === 'messageThread' || action === 'stopThread') return 'agent'
  if (action === 'searchWeb' || action === 'readWeb') return 'web'
  if (MIKKA_MCP_ACTIONS.has(action)) return 'mcp'
  if (action === 'viewIssues' || action === 'viewThreads' || action === 'findRepository' || action === 'readMail' || action === 'readSlack' || action === 'readNotion' || action === 'viewCalendar' || action === 'viewDrive' || action === 'viewFactory') {
    return 'search'
  }

  const op = dynamicOperation(name, inputFields)?.toLowerCase()
  if (op) return 'mcp'
  if (/^(?:read|view|open)_/.test(lower)) return 'read'
  if (/^(?:list)_/.test(lower)) return 'listFiles'
  if (/^(?:search|find|grep|get|query)_/.test(lower)) return 'search'
  if (/^(?:edit|write|update|patch|delete|remove|move)_/.test(lower)) return 'edit'
  return 'other'
}

function parseCommandEnvelope(value: unknown): { output: string; exitCode: number | null } | null {
  if (
    value &&
    typeof value === 'object' &&
    'output' in value &&
    typeof value.output === 'string' &&
    'exitCode' in value &&
    (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
  ) {
    return { output: value.output, exitCode: value.exitCode }
  }
  return null
}

function stepRawOutput(step: Pick<ThreadStep, 'output' | 'exitCode'>): string | undefined {
  const output = step.output
  if (!output || step.exitCode === undefined) return output
  try {
    return parseCommandEnvelope(JSON.parse(output))?.output ?? output
  } catch {
    return output
  }
}

function unwrapAggregatedOutput(rawOutput: string | undefined, explicitExitCode?: number | null): {
  aggregatedOutput?: string
  exitCode?: number | null
} {
  let exitCode = explicitExitCode
  if (!rawOutput) return exitCode !== undefined ? { exitCode } : {}

  const trimmed = rawOutput.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const cmdRes = parseCommandEnvelope(parsed)
      if (cmdRes) {
        return {
          ...(cmdRes.output ? { aggregatedOutput: truncateMiddle(cmdRes.output, MAX_OUTPUT_CHARS) } : {}),
          exitCode: exitCode ?? cmdRes.exitCode,
        }
      }
      const obj = recordOf(parsed)
      if (exitCode === undefined) {
        exitCode = validExitCode(obj.exitCode ?? obj.exit_code)
      }
      const stdout = typeof obj.stdout === 'string' ? obj.stdout : undefined
      const stderr = typeof obj.stderr === 'string' ? obj.stderr : undefined
      if (stdout !== undefined || stderr !== undefined) {
        const combined = [stdout, stderr].filter(part => part && part.length > 0).join('\n')
        return {
          ...(combined ? { aggregatedOutput: truncateMiddle(combined, MAX_OUTPUT_CHARS) } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        }
      }
      if (typeof obj.output === 'string') {
        return {
          ...(obj.output ? { aggregatedOutput: truncateMiddle(obj.output, MAX_OUTPUT_CHARS) } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        }
      }
    } catch {
      // Partial / truncated JSON preview: fall back to previewFields for exitCode and raw text.
      const fields = previewFields(trimmed)
      if (exitCode === undefined) exitCode = validExitCode(fields.exitCode ?? fields.exit_code)
      if (typeof fields.output === 'string' && fields.output) {
        return {
          aggregatedOutput: truncateMiddle(fields.output, MAX_OUTPUT_CHARS),
          ...(exitCode !== undefined ? { exitCode } : {}),
        }
      }
    }
  }

  return {
    aggregatedOutput: truncateMiddle(rawOutput, MAX_OUTPUT_CHARS),
    ...(exitCode !== undefined ? { exitCode } : {}),
  }
}

function isDeclinedError(code?: string, detail?: string, message?: string): boolean {
  return [code, detail, message].some(part => typeof part === 'string' && DECLINED_PATTERN.test(part))
}

function extractMcpIdentity(name: string, inputFields: Record<string, unknown>, args: Record<string, unknown>): { server: string; tool: string } {
  const parsed = parseMcpName(name)
  if (parsed) return parsed
  const op = dynamicOperation(name, inputFields)
  if (name === 'github_call' || name === 'github_tools') return { server: 'github', tool: op ?? name }
  if (name === 'call_personal_mcp_tool') {
    const server = nonEmptyString(inputFields.server ?? args.server ?? args.serverName, 80) ?? 'mcp'
    return { server, tool: op ?? name }
  }
  if (name === 'call_app_tool') {
    const server = nonEmptyString(inputFields.toolkit ?? args.toolkit ?? args.app ?? args.connector, 80) ?? 'app'
    return { server, tool: op ?? name }
  }
  return { server: 'mikka', tool: op ?? name }
}

function extractTargetThreadId(args: Record<string, unknown>, outputFields: Record<string, unknown>): string | undefined {
  for (const source of [outputFields, args]) {
    for (const key of ['runId', 'threadId', 'receiverThreadId', 'targetThreadId']) {
      const val = nonEmptyString(source[key], 120)
      if (val) return val
    }
  }
  return undefined
}

function buildCompactDetail(
  kind: CodexToolKind,
  opts: {
    command?: string
    path?: string
    query?: string
    url?: string
    quote?: string
    target?: string
    server?: string
    tool?: string
    fileChange?: CodexFileChange
    fallbackDetail?: string | null
  },
): string | undefined {
  if (kind === 'exec' && opts.command) return nonEmptyString(opts.command, MAX_DETAIL_CHARS)
  if (kind === 'edit' && opts.fileChange?.path) return nonEmptyString(opts.fileChange.path, MAX_DETAIL_CHARS)
  if (kind === 'read' && opts.path) return nonEmptyString(opts.path, MAX_DETAIL_CHARS)
  if (kind === 'listFiles' && opts.path) return nonEmptyString(opts.path, MAX_DETAIL_CHARS)
  if (kind === 'search' && (opts.query || opts.path)) return nonEmptyString(opts.query ?? opts.path, MAX_DETAIL_CHARS)
  if (kind === 'web' && (opts.query || opts.url)) return nonEmptyString(opts.query ?? opts.url, MAX_DETAIL_CHARS)
  if (opts.quote) return nonEmptyString(opts.quote, MAX_DETAIL_CHARS)
  if (opts.target) return nonEmptyString(opts.target, MAX_DETAIL_CHARS)
  if (opts.fallbackDetail) return nonEmptyString(opts.fallbackDetail, MAX_DETAIL_CHARS)
  if (kind === 'mcp' && opts.server && opts.tool) return nonEmptyString(`${opts.server} · ${opts.tool}`, MAX_DETAIL_CHARS)
  return undefined
}

/**
 * Extracts per-call timestamps (`startedAtMs`, `completedAtMs`), shell `cwd`,
 * raw input (for large edit diffs / `cwd`), and `errorText` from scoped run chunks.
 */
export function extractThreadStepContext(
  chunks: readonly { chunk: Record<string, unknown>; at: Date | string | number }[],
): Map<string, ThreadStepChunkContext> {
  const map = new Map<string, ThreadStepChunkContext>()
  for (const row of chunks) {
    const chunk = row.chunk
    const type = chunk?.type
    if (typeof type !== 'string' || chunk.toolCallId === undefined) continue
    const callId = String(chunk.toolCallId)
    const atMs = validTimestampMs(row.at)
    let entry = map.get(callId)
    if (!entry) { entry = {}; map.set(callId, entry) }

    if (type === 'tool-input-start' || type === 'tool-input-available' || type === 'tool-input-error') {
      if (entry.startedAtMs === undefined && atMs !== undefined) entry.startedAtMs = atMs
      if (chunk.input !== undefined) {
        entry.rawInput = chunk.input
        const rec = recordOf(chunk.input)
        const cwd = extractCwd(rec)
        if (cwd) entry.cwd = cwd
        const cmd = extractRawShellCommand(rec)
        if (cmd) entry.rawCommand = cmd
      }
      if (type === 'tool-input-error' && typeof chunk.errorText === 'string' && chunk.errorText.trim()) {
        entry.errorText = truncateEnd(chunk.errorText.trim(), MAX_ERROR_CHARS)
        if (atMs !== undefined) entry.completedAtMs = atMs
      }
    } else if (type === 'tool-output-available' || type === 'tool-output-error') {
      if (atMs !== undefined) entry.completedAtMs = atMs
      if (type === 'tool-output-error' && typeof chunk.errorText === 'string' && chunk.errorText.trim()) {
        entry.errorText = truncateEnd(chunk.errorText.trim(), MAX_ERROR_CHARS)
      }
    }
  }
  return map
}

type TimingInput = {
  startedAtMs?: unknown
  completedAtMs?: unknown
  durationMs?: unknown
  ms?: unknown
}

function resolveTiming(input: TimingInput): { startedAtMs?: number; completedAtMs?: number; durationMs?: number } {
  const startedAtMs = validTimestampMs(input.startedAtMs)
  let completedAtMs = validTimestampMs(input.completedAtMs)
  let durationMs = validDurationMs(input.durationMs ?? input.ms)
  if (durationMs === undefined && startedAtMs !== undefined && completedAtMs !== undefined && completedAtMs >= startedAtMs) {
    durationMs = Math.round(completedAtMs - startedAtMs)
  }
  if (completedAtMs === undefined && startedAtMs !== undefined && durationMs !== undefined) {
    completedAtMs = startedAtMs + durationMs
  }
  return {
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

/** Enriches one Coordinator/Bot ChatTool into the Codex Electron 1:1 mobile wire projection. */
export function enrichMobileChatTool(
  tool: ChatTool & { startedAtMs?: unknown; completedAtMs?: unknown; durationMs?: unknown; ms?: unknown },
  opts: { itemStopped?: boolean } = {},
): MobileChatTool {
  const inputFields = previewFields(tool.input)
  const args = effectiveArgs(tool.name, inputFields)
  const outputFields = previewFields(tool.output)
  const lower = tool.name.toLowerCase()
  const explicitShell = isShellToolName(lower)
  const rawShellCmd = explicitShell
    ? extractRawShellCommand(args, undefined, true)
    : (!EDIT_NAMES.has(lower) && !AGENT_NAMES.has(lower) && !WEB_NAMES.has(lower) ? extractRawShellCommand(args, undefined, false) : undefined)

  let kind: CodexToolKind
  let command: string | undefined
  let cwd = extractCwd(args)
  let commandActions: CodexCommandAction[] | undefined
  let path: string | undefined
  let query: string | undefined
  let url: string | undefined
  let fileChanges: CodexFileChange[] | undefined
  let server: string | undefined
  let mcpTool: string | undefined
  let agentAction: CodexAgentAction | undefined
  let targetThreadId: string | undefined

  if (rawShellCmd) {
    const classified = classifyShellCommand(rawShellCmd)
    kind = classified.kind
    command = classified.command
    commandActions = classified.commandActions
    if (!cwd && classified.inferredCwd) cwd = classified.inferredCwd
    path = classified.path
    query = classified.query
  } else if (explicitShell) {
    kind = 'exec'
  } else {
    kind = classifyNonShellKind(tool.name, inputFields)
    if (kind === 'read') {
      path = nonEmptyString(args.file_path ?? args.path ?? args.notebook_path ?? args.file ?? tool.target, 400, false)
    } else if (kind === 'listFiles') {
      path = nonEmptyString(args.path ?? args.directory ?? args.dir ?? args.pattern ?? tool.target, 400, false)
    } else if (kind === 'search') {
      query = nonEmptyString(args.pattern ?? args.query ?? args.q ?? args.search ?? tool.target, MAX_DETAIL_CHARS)
      path = nonEmptyString(args.path ?? args.directory ?? args.repository ?? args.repo, 400, false)
    } else if (kind === 'edit') {
      const changes = extractFileChanges(tool.name, args, tool.output, tool.target, tool.input)
      if (changes.length) {
        fileChanges = changes
        path = changes[0].path
      }
    } else if (kind === 'web') {
      url = nonEmptyString(args.url, 500, false)
      query = nonEmptyString(args.query ?? args.q ?? args.task ?? args.prompt ?? (!url ? tool.target : undefined), MAX_DETAIL_CHARS)
    } else if (kind === 'mcp') {
      const identity = extractMcpIdentity(tool.name, inputFields, args)
      server = identity.server
      mcpTool = identity.tool
    } else if (kind === 'agent') {
      agentAction = classifyAgentAction(tool.name)
      targetThreadId = extractTargetThreadId(args, outputFields)
    }
  }

  const failure = toolFailure(tool)
  const rawErrorText = tool.errorCode && tool.errorDetail
    ? `${tool.errorCode} (${tool.errorDetail})`
    : tool.errorCode ?? failure.reason ?? (tool.state === 'error' ? nonEmptyString(tool.output, MAX_ERROR_CHARS, false) : undefined)

  let status: CodexToolStatus
  let interrupted: true | undefined
  if (tool.state === 'running') {
    if (opts.itemStopped) {
      status = 'declined'
      interrupted = true
    } else {
      status = 'running'
    }
  } else if (isDeclinedError(tool.errorCode, tool.errorDetail, rawErrorText)) {
    status = 'declined'
  } else if (tool.state === 'error' || failure.failed) {
    status = 'failed'
  } else {
    status = 'completed'
  }

  const isShellDerived = explicitShell || Boolean(rawShellCmd)
  const { aggregatedOutput, exitCode } = isShellDerived
    ? unwrapAggregatedOutput(tool.output)
    : { aggregatedOutput: undefined, exitCode: validExitCode(outputFields.exitCode ?? outputFields.exit_code) }

  if (status === 'completed' && typeof exitCode === 'number' && exitCode !== 0) {
    status = 'failed'
  }

  const parsedArguments = !isShellDerived ? parseBoundedPayload(tool.input) : undefined
  const parsedResult = !isShellDerived && status !== 'failed' && status !== 'declined'
    ? parseBoundedPayload(tool.output)
    : undefined
  const error = status === 'failed' || status === 'declined'
    ? nonEmptyString(rawErrorText ?? (typeof exitCode === 'number' && exitCode !== 0 ? `Exit code ${exitCode}` : undefined), MAX_ERROR_CHARS, false)
    : undefined

  const timing = resolveTiming(tool)
  const fileChange = fileChanges?.[0]
  const detail = buildCompactDetail(kind, {
    command, path, query, url, quote: tool.quote, target: tool.target, server, tool: mcpTool, fileChange,
  })

  return {
    ...tool,
    kind,
    status,
    ...(interrupted ? { interrupted } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(commandActions?.length ? { commandActions } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(aggregatedOutput !== undefined ? { aggregatedOutput } : {}),
    ...timing,
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    ...(fileChange ? { fileChange } : {}),
    ...(fileChanges && fileChanges.length > 0 ? { fileChanges } : {}),
    ...(server ? { server } : {}),
    ...(mcpTool ? { tool: mcpTool } : {}),
    ...(agentAction ? { agentAction } : {}),
    ...(targetThreadId ? { targetThreadId } : {}),
    ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
    ...(parsedResult !== undefined ? { result: parsedResult } : {}),
    ...(error ? { error } : {}),
    ...(detail ? { detail } : {}),
  }
}

/** Enriches all `activity.tools[]` across `/api/mobile/chat` items without mutating cached rows. */
export function enrichMobileChatItems<T extends ChatItem>(items: readonly T[]): T[] {
  return items.map(item => {
    if (!item.activity?.tools?.length) return item
    return {
      ...item,
      activity: {
        ...item.activity,
        tools: item.activity.tools.map(tool => enrichMobileChatTool(tool, { itemStopped: item.stopped === true })),
      },
    }
  })
}

/** Enriches one Agent ThreadStep into the Codex Electron 1:1 mobile wire projection. */
export function enrichMobileThreadStep(
  step: ThreadStep,
  opts: { active?: boolean; context?: ThreadStepChunkContext } = {},
): MobileThreadStep {
  const ctx = opts.context
  const inputSource = step.input !== undefined ? parseBoundedPayload(step.input) : ctx?.rawInput
  const inputFields = recordOf(inputSource)
  const args = effectiveArgs(step.name, inputFields)
  const lower = step.name.toLowerCase()

  const isShellStep = step.kind === 'shell' || isShellToolName(lower) || Boolean(step.command)
  const rawShellCmd = isShellStep ? extractRawShellCommand(args, ctx?.rawCommand ?? step.command, true) : undefined
  const rawInputText = typeof inputSource === 'string' ? inputSource : typeof ctx?.rawInput === 'string' ? ctx.rawInput : undefined

  let kind: CodexToolKind
  let command: string | undefined
  let cwd = extractCwd(args, ctx?.cwd)
  let commandActions: CodexCommandAction[] | undefined
  let path: string | undefined
  let query: string | undefined
  let url: string | undefined
  let fileChanges: CodexFileChange[] | undefined
  let server: string | undefined
  let mcpTool: string | undefined
  let agentAction: CodexAgentAction | undefined
  let targetThreadId: string | undefined

  if (rawShellCmd) {
    const classified = classifyShellCommand(rawShellCmd)
    kind = classified.kind
    command = classified.command
    commandActions = classified.commandActions
    if (!cwd && classified.inferredCwd) cwd = classified.inferredCwd
    path = classified.path
    query = classified.query
  } else if (isShellStep) {
    kind = 'exec'
  } else {
    kind = classifyNonShellKind(step.name, inputFields)
    if (kind === 'other' && step.kind === 'delegate') kind = 'agent'
    else if (kind === 'other' && step.kind === 'todo') kind = 'think'
    else if (kind === 'other' && step.kind === 'read') kind = 'read'
    else if (kind === 'other' && step.kind === 'search') kind = 'search'
    else if (kind === 'other' && step.kind === 'edit') kind = 'edit'
    else if (kind === 'other' && step.kind === 'web') kind = 'web'

    if (kind === 'read') {
      path = nonEmptyString(args.file_path ?? args.path ?? args.notebook_path ?? args.file ?? step.target, 400, false)
    } else if (kind === 'listFiles') {
      path = nonEmptyString(args.path ?? args.directory ?? args.dir ?? step.scope ?? step.target, 400, false)
    } else if (kind === 'search') {
      query = nonEmptyString(args.pattern ?? args.query ?? args.q ?? step.target, MAX_DETAIL_CHARS)
      path = nonEmptyString(args.path ?? args.directory ?? step.scope, 400, false)
    } else if (kind === 'edit') {
      const changes = extractFileChanges(step.name, args, step.output, step.target, rawInputText)
      if (changes.length) {
        fileChanges = changes
        path = changes[0].path
      }
    } else if (kind === 'web') {
      url = nonEmptyString(args.url ?? (step.target?.startsWith('http') ? step.target : undefined), 500, false)
      query = nonEmptyString(args.query ?? args.q ?? args.prompt ?? (!url ? step.target : undefined), MAX_DETAIL_CHARS)
    } else if (kind === 'mcp') {
      const identity = extractMcpIdentity(step.name, inputFields, args)
      server = identity.server
      mcpTool = identity.tool
    } else if (kind === 'agent') {
      agentAction = classifyAgentAction(step.name)
      const outputFields = step.output ? previewFields(step.output) : {}
      targetThreadId = extractTargetThreadId(args, outputFields)
    }
  }

  const rawOutput = stepRawOutput(step)
  const { aggregatedOutput, exitCode } = isShellStep
    ? unwrapAggregatedOutput(rawOutput, step.exitCode)
    : { aggregatedOutput: undefined, exitCode: step.exitCode }

  let status: CodexToolStatus
  let interrupted: true | undefined
  if (step.status === 'running') {
    if (opts.active === false) {
      status = 'declined'
      interrupted = true
    } else {
      status = 'running'
    }
  } else if (isDeclinedError(undefined, undefined, ctx?.errorText ?? aggregatedOutput ?? step.output)) {
    status = 'declined'
  } else if (step.failed || step.status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0)) {
    status = 'failed'
  } else {
    status = 'completed'
  }

  const parsedArguments = !isShellStep ? parseBoundedPayload(step.input ?? ctx?.rawInput) : undefined
  const parsedResult = !isShellStep && status !== 'failed' && status !== 'declined'
    ? parseBoundedPayload(rawOutput)
    : undefined
  const error = status === 'failed' || status === 'declined'
    ? nonEmptyString(
        ctx?.errorText ?? (isShellStep ? aggregatedOutput : rawOutput) ?? (typeof exitCode === 'number' && exitCode !== 0 ? `Exit code ${exitCode}` : undefined),
        MAX_ERROR_CHARS,
        false,
      )
    : undefined

  const timing = resolveTiming({
    startedAtMs: ctx?.startedAtMs,
    completedAtMs: ctx?.completedAtMs,
    ms: step.ms,
  })
  const fileChange = fileChanges?.[0]
  const detail = buildCompactDetail(kind, {
    command, path, query, url, target: step.target, server, tool: mcpTool, fileChange, fallbackDetail: step.detail,
  }) ?? step.detail

  return {
    ...step,
    kind,
    status,
    detail,
    ...(interrupted ? { interrupted } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(commandActions?.length ? { commandActions } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(aggregatedOutput !== undefined ? { aggregatedOutput } : {}),
    ...timing,
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    ...(fileChange ? { fileChange } : {}),
    ...(fileChanges && fileChanges.length > 0 ? { fileChanges } : {}),
    ...(server ? { server } : {}),
    ...(mcpTool ? { tool: mcpTool } : {}),
    ...(agentAction ? { agentAction } : {}),
    ...(targetThreadId ? { targetThreadId } : {}),
    ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
    ...(parsedResult !== undefined ? { result: parsedResult } : {}),
    ...(error ? { error } : {}),
  }
}

/** Enriches all `steps` items in `/api/mobile/threads/[id]` without mutating shared objects. */
export function enrichMobileThreadItems(
  items: readonly ThreadItem[],
  opts: EnrichMobileThreadOptions = {},
): MobileThreadItem[] {
  return items.map(item => item.kind === 'steps'
    ? {
        ...item,
        steps: item.steps.map(step => enrichMobileThreadStep(step, {
          active: opts.active,
          context: opts.contextByCallId?.get(step.id),
        })),
      }
    : item)
}
