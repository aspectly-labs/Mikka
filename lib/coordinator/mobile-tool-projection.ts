// Codex Electron 1:1 Tool-Use projection for Bot chats (/api/mobile/chat) and
// Agent threads (/api/mobile/threads/[id]). Pure, non-mutating, backward-compatible
// with legacy ThreadStep fields, and bounded by length only (no regex secret masking
// or UUID scrubbing — mirrors Codex Electron, Cursor, and Claude Desktop).
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
  /** Codex 1:1 tool category for rendering & exploration coalescing. */
  codexKind: CodexToolKind
  /** Codex lifecycle status (`running` while active; `declined` when denied or interrupted mid-call). */
  codexStatus: CodexToolStatus
  /** True when the turn/run was stopped while this tool was in progress. */
  interrupted?: true
  /** Verbatim command with shell wrapper (`/bin/zsh -lc '...'`) stripped; no secret/UUID redaction. */
  command?: string
  /** Working directory for shell/exec commands when provided in tool input or leading `cd`. */
  cwd?: string
  /** Codex `CommandAction[]` parsed from shell commands (`read` / `listFiles` / `search` / `unknown`). */
  commandActions?: CodexCommandAction[]
  /** Exit code for shell/exec commands (`0` success, non-zero failure, `null` when unknown/signaled). */
  exitCode?: number | null
  /** Bounded raw stdout/stderr output (unwrapped once from `{ output, exitCode }`; no regex redaction). */
  aggregatedOutput?: string
  /** Execution duration in milliseconds when recorded or derived from timestamps. */
  durationMs?: number
  /** Epoch ms when the tool call started (consistent with `durationMs` when both exist). */
  startedAtMs?: number
  /** Epoch ms when the tool call finished. */
  completedAtMs?: number
  /** Primary file path (`read` / `listFiles` / `search` / `edit`). */
  path?: string
  /** Search query / pattern (`search` / `web`). */
  query?: string
  /** Web URL (`web`). */
  url?: string
  /** Primary file change summary (`edit`). */
  fileChange?: CodexFileChange
  /** All file changes for multi-file patches such as `apply_patch` (`edit`). */
  fileChanges?: CodexFileChange[]
  /** MCP server / connector / namespace name (`mcp`). */
  server?: string
  /** MCP / dynamic tool operation name (`mcp`). */
  tool?: string
  /** Subagent / dispatch action verb (`agent`). */
  agentAction?: CodexAgentAction
  /** Dispatched / target thread run ID (`agent`, verbatim UUID — never scrubbed). */
  targetThreadId?: string
  /** Bounded raw arguments for expandable MCP/agent/tool cards (no regex redaction). */
  arguments?: unknown
  /** Bounded raw result payload for expandable MCP/agent/tool cards (no regex redaction). */
  result?: unknown
  /** Error message or code when the tool failed or was declined (no regex redaction). */
  error?: string
  /** Compact 1-line human detail / subject fallback (no regex redaction). */
  detail?: string
}

/**
 * `/api/mobile/chat` tool entry: `ChatTool` had no prior `kind` or `status`, so both
 * `kind`/`status` and `codexKind`/`codexStatus` are additive and identical.
 */
export type MobileChatTool = ChatTool &
  CodexToolProjectionFields & {
    kind: CodexToolKind
    status: CodexToolStatus
  }

/**
 * `/api/mobile/threads/[id]` step entry: preserves legacy `ThreadStep.kind` (`shell`, `read`, …)
 * and `ThreadStep.status` (`running`, `ok`, `failed`) for installed clients while adding Codex
 * 1:1 fields (`codexKind`, `codexStatus`, `commandActions`, `aggregatedOutput`, `fileChanges`, …).
 */
export type MobileThreadStep = ThreadStep & Omit<CodexToolProjectionFields, 'detail'>

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
  toolName?: string
  fileChangeEvents?: CodexFileChange[]
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

function parseRawJson(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      const partial = previewFields(trimmed)
      if (Object.keys(partial).length > 0) return partial
    }
  }
  return trimmed
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

/** Splits on top-level operators (`&&`, `||`, `;`, unquoted newlines, or `|`) outside quotes. */
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
    if (ch === '\\') {
      if (next === '\n') { i++; continue } // Line continuation
      if (next === '\r' && command[i + 2] === '\n') { i += 2; continue }
      current += ch
      escaped = true
      continue
    }
    if (ch === "'" || ch === '"') { current += ch; quote = ch; continue }
    if (mode === 'chain') {
      if (ch === ';' || ch === '\n' || ch === '\r') {
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
  fileChangeEvents?: readonly CodexFileChange[],
): CodexFileChange[] {
  // 1. Authoritative per-file change events emitted by the Codex daemon adapter (`data-file-change`).
  if (fileChangeEvents && fileChangeEvents.length > 0) {
    return fileChangeEvents.map(entry => ({ ...entry }))
  }

  // 2. Patch text (`*** Update File:` or `diff --git`).
  const patchText = [rawInputText, args.patch, args.input, args.diff, rawOutput].find(
    (v): v is string => typeof v === 'string' && (v.includes('*** ') || v.includes('diff --git ')),
  )
  if (patchText) {
    const parsed = parsePatchText(patchText)
    if (parsed.length > 0) return parsed
  }

  // 3. Multi-file list from Codex `apply_patch` input (`input: { files: [...] }`).
  if (Array.isArray(args.files)) {
    const files = args.files
      .map(entry => nonEmptyString(entry, 400, false))
      .filter((entry): entry is string => Boolean(entry))
    if (files.length > 0) {
      return files.map(filePath => ({ path: filePath, changeKind: 'update' as const }))
    }
  }

  const lower = name.toLowerCase()
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

/** Unwraps Codex `{ output, exitCode }` envelope once when `step.exitCode` is recorded. */
function stepRawOutput(step: Pick<ThreadStep, 'output' | 'exitCode'>): string | undefined {
  const output = step.output
  if (!output || step.exitCode === undefined) return output
  try {
    return parseCommandEnvelope(JSON.parse(output))?.output ?? output
  } catch {
    return output
  }
}

/** Unwraps shell-result envelopes from Coordinator/Bot tool outputs without rewriting arbitrary JSON stdout. */
function unwrapChatShellOutput(rawOutput: string | undefined): {
  aggregatedOutput?: string
  exitCode?: number | null
} {
  if (!rawOutput) return {}
  const trimmed = rawOutput.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const cmdRes = parseCommandEnvelope(parsed)
      if (cmdRes) {
        return {
          ...(cmdRes.output ? { aggregatedOutput: truncateMiddle(cmdRes.output, MAX_OUTPUT_CHARS) } : {}),
          exitCode: cmdRes.exitCode,
        }
      }
      const obj = recordOf(parsed)
      const exitCode = validExitCode(obj.exitCode ?? obj.exit_code)
      const stdout = typeof obj.stdout === 'string' ? obj.stdout : undefined
      const stderr = typeof obj.stderr === 'string' ? obj.stderr : undefined
      if (stdout !== undefined || stderr !== undefined) {
        const combined = [stdout, stderr].filter(part => part && part.length > 0).join('\n')
        return {
          ...(combined ? { aggregatedOutput: truncateMiddle(combined, MAX_OUTPUT_CHARS) } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
        }
      }
      if (exitCode !== undefined && typeof obj.output === 'string') {
        return {
          ...(obj.output ? { aggregatedOutput: truncateMiddle(obj.output, MAX_OUTPUT_CHARS) } : {}),
          exitCode,
        }
      }
    } catch {
      const fields = previewFields(trimmed)
      const exitCode = validExitCode(fields.exitCode ?? fields.exit_code)
      if (exitCode !== undefined && typeof fields.output === 'string' && fields.output) {
        return {
          aggregatedOutput: truncateMiddle(fields.output, MAX_OUTPUT_CHARS),
          exitCode,
        }
      }
    }
  }
  return { aggregatedOutput: truncateMiddle(rawOutput, MAX_OUTPUT_CHARS) }
}

/** Reads structured Codex/tool outcome statuses (e.g. `apply_patch` `{ status: "failed" | "declined" }`). */
function structuredOutputStatus(raw: string | undefined): CodexToolStatus | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return undefined
  let statusVal: unknown
  try {
    const parsed: unknown = JSON.parse(trimmed)
    statusVal = recordOf(parsed).status
  } catch {
    statusVal = previewFields(trimmed).status
  }
  if (typeof statusVal !== 'string') return undefined
  const lower = statusVal.trim().toLowerCase()
  if (lower === 'declined' || lower === 'denied' || lower === 'rejected') return 'declined'
  if (lower === 'failed' || lower === 'error') return 'failed'
  if (lower === 'inprogress' || lower === 'in_progress' || lower === 'running') return 'running'
  return undefined
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
 * complete input (for edit diff stats / `cwd`), `errorText`, and Codex adapter
 * `data-file-change` events from scoped run chunks.
 */
export function extractThreadStepContext(
  chunks: readonly { chunk: Record<string, unknown>; at: Date | string | number }[],
): Map<string, ThreadStepChunkContext> {
  const map = new Map<string, ThreadStepChunkContext>()
  let lastPatchCallId: string | null = null

  for (const row of chunks) {
    const chunk = row.chunk
    const type = chunk?.type
    if (typeof type !== 'string') continue

    if (type === 'data-file-change' && lastPatchCallId !== null) {
      const data = recordOf(chunk.data)
      const filePath = nonEmptyString(data.path, 400, false)
      if (filePath) {
        const change = typeof data.change === 'string' ? data.change.toLowerCase() : ''
        const changeKind: CodexFileChangeKind = change === 'added' || change === 'add'
          ? 'add'
          : change === 'deleted' || change === 'delete'
            ? 'delete'
            : 'update'
        const target = map.get(lastPatchCallId)
        if (target) {
          target.fileChangeEvents ??= []
          target.fileChangeEvents.push({ path: filePath, changeKind })
        }
      }
      continue
    }

    if (chunk.toolCallId === undefined) {
      lastPatchCallId = null
      continue
    }

    const callId = String(chunk.toolCallId)
    const atMs = validTimestampMs(row.at)
    let entry = map.get(callId)
    if (!entry) { entry = {}; map.set(callId, entry) }

    if (type === 'tool-input-start' || type === 'tool-input-available' || type === 'tool-input-error') {
      lastPatchCallId = null
      if (entry.startedAtMs === undefined && atMs !== undefined) entry.startedAtMs = atMs
      if (typeof chunk.toolName === 'string' && chunk.toolName.trim()) entry.toolName = chunk.toolName.trim()
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
      lastPatchCallId = type === 'tool-output-available' && EDIT_NAMES.has((entry.toolName ?? '').toLowerCase())
        ? callId
        : null
    } else {
      lastPatchCallId = null
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
  let startedAtMs = validTimestampMs(input.startedAtMs)
  let completedAtMs = validTimestampMs(input.completedAtMs)
  let durationMs = validDurationMs(input.durationMs ?? input.ms)

  if (durationMs !== undefined && startedAtMs !== undefined && completedAtMs !== undefined) {
    // When both chunks arrived in the same DB batch (identical insert times), align `startedAtMs`
    // backwards from the batch completion timestamp using the measured runtime so clocks stay consistent.
    if (startedAtMs === completedAtMs && durationMs > 0) {
      startedAtMs = Math.max(1, completedAtMs - durationMs)
    } else if (completedAtMs < startedAtMs) {
      completedAtMs = startedAtMs + durationMs
    }
  } else if (durationMs === undefined && startedAtMs !== undefined && completedAtMs !== undefined && completedAtMs >= startedAtMs) {
    durationMs = Math.round(completedAtMs - startedAtMs)
  } else if (completedAtMs === undefined && startedAtMs !== undefined && durationMs !== undefined) {
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
  const { startedAtMs: rawStart, completedAtMs: rawEnd, durationMs: rawDuration, ms: rawMs, ...baseTool } = tool
  const rawInputSource = parseRawJson(baseTool.input)
  const inputFields = recordOf(rawInputSource)
  const args = effectiveArgs(baseTool.name, inputFields)
  const outputFields = previewFields(baseTool.output)
  const lower = baseTool.name.toLowerCase()

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
    kind = classifyNonShellKind(baseTool.name, inputFields)
    if (kind === 'read') {
      path = nonEmptyString(args.file_path ?? args.path ?? args.notebook_path ?? args.file ?? baseTool.target, 400, false)
    } else if (kind === 'listFiles') {
      path = nonEmptyString(args.path ?? args.directory ?? args.dir ?? args.pattern ?? baseTool.target, 400, false)
    } else if (kind === 'search') {
      query = nonEmptyString(args.pattern ?? args.query ?? args.q ?? args.search ?? baseTool.target, MAX_DETAIL_CHARS)
      path = nonEmptyString(args.path ?? args.directory ?? args.repository ?? args.repo, 400, false)
    } else if (kind === 'edit') {
      const changes = extractFileChanges(
        baseTool.name,
        args,
        baseTool.output,
        baseTool.target,
        typeof rawInputSource === 'string' ? rawInputSource : undefined,
      )
      if (changes.length) {
        fileChanges = changes
        path = changes[0].path
      }
    } else if (kind === 'web') {
      url = nonEmptyString(args.url, 500, false)
      query = nonEmptyString(args.query ?? args.q ?? args.task ?? args.prompt ?? (!url ? baseTool.target : undefined), MAX_DETAIL_CHARS)
    } else if (kind === 'mcp') {
      const identity = extractMcpIdentity(baseTool.name, inputFields, args)
      server = identity.server
      mcpTool = identity.tool
    } else if (kind === 'agent') {
      agentAction = classifyAgentAction(baseTool.name)
      targetThreadId = extractTargetThreadId(args, outputFields)
    }
  }

  const isShellDerived = explicitShell || Boolean(rawShellCmd)
  const { aggregatedOutput, exitCode } = isShellDerived
    ? unwrapChatShellOutput(baseTool.output)
    : { aggregatedOutput: undefined, exitCode: validExitCode(outputFields.exitCode ?? outputFields.exit_code) }

  const failure = toolFailure(baseTool)
  const outStatus = !isShellDerived ? structuredOutputStatus(baseTool.output) : undefined
  const rawErrorText = baseTool.errorCode && baseTool.errorDetail
    ? `${baseTool.errorCode} (${baseTool.errorDetail})`
    : baseTool.errorCode ?? failure.reason ?? (baseTool.state === 'error' ? nonEmptyString(baseTool.output, MAX_ERROR_CHARS, false) : undefined)

  let status: CodexToolStatus
  let interrupted: true | undefined
  if (baseTool.state === 'running') {
    if (opts.itemStopped) {
      status = 'declined'
      interrupted = true
    } else {
      status = 'running'
    }
  } else if (outStatus === 'declined') {
    status = 'declined'
  } else if (baseTool.state === 'error' || failure.failed || (typeof exitCode === 'number' && exitCode !== 0) || outStatus === 'failed') {
    status = isDeclinedError(baseTool.errorCode, baseTool.errorDetail, rawErrorText) ? 'declined' : 'failed'
  } else {
    status = 'completed'
  }

  const parsedArguments = !isShellDerived ? parseBoundedPayload(baseTool.input) : undefined
  const parsedResult = !isShellDerived && status !== 'failed' && status !== 'declined'
    ? parseBoundedPayload(baseTool.output)
    : undefined
  const error = status === 'failed' || status === 'declined'
    ? nonEmptyString(rawErrorText ?? (typeof exitCode === 'number' && exitCode !== 0 ? `Exit code ${exitCode}` : undefined), MAX_ERROR_CHARS, false)
    : undefined

  const timing = resolveTiming({ startedAtMs: rawStart, completedAtMs: rawEnd, durationMs: rawDuration, ms: rawMs })
  const fileChange = fileChanges?.[0]
  const detail = buildCompactDetail(kind, {
    command, path, query, url, quote: baseTool.quote, target: baseTool.target, server, tool: mcpTool, fileChange,
  })

  return {
    ...baseTool,
    kind,
    status,
    codexKind: kind,
    codexStatus: status,
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

/**
 * Enriches one Agent ThreadStep with additive Codex Electron 1:1 fields (`codexKind`,
 * `codexStatus`, `commandActions`, `aggregatedOutput`, `fileChanges`, timing, …) while
 * preserving legacy `step.kind` and `step.status` for installed clients.
 */
export function enrichMobileThreadStep(
  step: ThreadStep,
  opts: { active?: boolean; context?: ThreadStepChunkContext } = {},
): MobileThreadStep {
  const ctx = opts.context
  // Prefer complete chunk input before display truncation so edit diffs past 1024 chars compute accurately.
  const rawInputSource = ctx?.rawInput !== undefined ? ctx.rawInput : parseRawJson(step.input)
  const inputFields = recordOf(rawInputSource)
  const args = effectiveArgs(step.name, inputFields)
  const lower = step.name.toLowerCase()

  const isShellStep = step.kind === 'shell' || isShellToolName(lower) || Boolean(step.command)
  const rawShellCmd = isShellStep ? extractRawShellCommand(args, ctx?.rawCommand ?? step.command, true) : undefined
  const rawInputText = typeof rawInputSource === 'string' ? rawInputSource : undefined

  let codexKind: CodexToolKind
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
    codexKind = classified.kind
    command = classified.command
    commandActions = classified.commandActions
    if (!cwd && classified.inferredCwd) cwd = classified.inferredCwd
    path = classified.path
    query = classified.query
  } else if (isShellStep) {
    codexKind = 'exec'
  } else {
    codexKind = classifyNonShellKind(step.name, inputFields)
    if (codexKind === 'other' && step.kind === 'delegate') codexKind = 'agent'
    else if (codexKind === 'other' && step.kind === 'todo') codexKind = 'think'
    else if (codexKind === 'other' && step.kind === 'read') codexKind = 'read'
    else if (codexKind === 'other' && step.kind === 'search') codexKind = 'search'
    else if (codexKind === 'other' && step.kind === 'edit') codexKind = 'edit'
    else if (codexKind === 'other' && step.kind === 'web') codexKind = 'web'

    if (codexKind === 'read') {
      path = nonEmptyString(args.file_path ?? args.path ?? args.notebook_path ?? args.file ?? step.target, 400, false)
    } else if (codexKind === 'listFiles') {
      path = nonEmptyString(args.path ?? args.directory ?? args.dir ?? step.scope ?? step.target, 400, false)
    } else if (codexKind === 'search') {
      query = nonEmptyString(args.pattern ?? args.query ?? args.q ?? step.target, MAX_DETAIL_CHARS)
      path = nonEmptyString(args.path ?? args.directory ?? step.scope, 400, false)
    } else if (codexKind === 'edit') {
      const changes = extractFileChanges(
        step.name,
        args,
        step.output,
        step.target,
        rawInputText,
        ctx?.fileChangeEvents,
      )
      if (changes.length) {
        fileChanges = changes
        path = changes[0].path
      }
    } else if (codexKind === 'web') {
      url = nonEmptyString(args.url ?? (step.target?.startsWith('http') ? step.target : undefined), 500, false)
      query = nonEmptyString(args.query ?? args.q ?? args.prompt ?? (!url ? step.target : undefined), MAX_DETAIL_CHARS)
    } else if (codexKind === 'mcp') {
      const identity = extractMcpIdentity(step.name, inputFields, args)
      server = identity.server
      mcpTool = identity.tool
    } else if (codexKind === 'agent') {
      agentAction = classifyAgentAction(step.name)
      const outputFields = step.output ? previewFields(step.output) : {}
      targetThreadId = extractTargetThreadId(args, outputFields)
    }
  }

  // Unwrap Codex `{ output, exitCode }` envelope once; never re-parse raw command stdout as a wrapper.
  const rawOutput = stepRawOutput(step)
  const exitCode = step.exitCode
  const aggregatedOutput = isShellStep && rawOutput !== undefined && rawOutput.length > 0
    ? truncateMiddle(rawOutput, MAX_OUTPUT_CHARS)
    : undefined

  const outStatus = !isShellStep ? structuredOutputStatus(rawOutput) : undefined
  const hasFailed = step.failed || step.status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0) || Boolean(ctx?.errorText)

  let codexStatus: CodexToolStatus
  let interrupted: true | undefined
  if (step.status === 'running') {
    if (opts.active === false) {
      codexStatus = 'declined'
      interrupted = true
    } else {
      codexStatus = 'running'
    }
  } else if (outStatus === 'declined') {
    codexStatus = 'declined'
  } else if (outStatus === 'failed' || hasFailed) {
    const failureText = ctx?.errorText ?? (isShellStep ? aggregatedOutput : rawOutput)
    codexStatus = isDeclinedError(undefined, undefined, failureText) ? 'declined' : 'failed'
  } else {
    codexStatus = 'completed'
  }

  const parsedArguments = !isShellStep ? parseBoundedPayload(rawInputSource) : undefined
  const parsedResult = !isShellStep && codexStatus !== 'failed' && codexStatus !== 'declined'
    ? parseBoundedPayload(rawOutput)
    : undefined
  const error = codexStatus === 'failed' || codexStatus === 'declined'
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
  const detail = buildCompactDetail(codexKind, {
    command, path, query, url, target: step.target, server, tool: mcpTool, fileChange, fallbackDetail: step.detail,
  }) ?? step.detail

  return {
    ...step,
    detail,
    codexKind,
    codexStatus,
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
