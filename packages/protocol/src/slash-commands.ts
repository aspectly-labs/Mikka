// Unified slash-command contract (ACP AvailableCommand shape, Apache-2.0) and
// structured composer mentions (#3333).
//
// Mikka does NOT switch any harness to ACP transport — Codex stays on
// `codex app-server` JSON-RPC, Claude Code stays on `@anthropic-ai/claude-agent-sdk`,
// and Eve stays on its HTTP channel. Only Mikka's daemon/runtime -> UI command
// catalogue message adopts ACP's `AvailableCommand` fields.
import { z } from 'zod'

export const AVAILABLE_COMMAND_SOURCES = [
  'mikka',
  'eve',
  'claude-code',
  'codex',
  'skill',
  'mcp',
] as const
export type AvailableCommandSource = (typeof AVAILABLE_COMMAND_SOURCES)[number]

export const availableCommandSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(500).default(''),
  input: z.object({ hint: z.string().max(200) }).optional(),
  _meta: z.object({
    source: z.enum(AVAILABLE_COMMAND_SOURCES),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    server: z.string().trim().min(1).max(120).optional(),
  }),
})
export type AvailableCommand = z.infer<typeof availableCommandSchema>

export const availableCommandsChunkDataSchema = z.object({
  harness: z.enum(['claude_code', 'codex', 'eve', 'mock']),
  commands: z.array(availableCommandSchema).max(500),
  terminalSlashCommands: z.array(z.string().max(160)).max(200).optional(),
})
export type AvailableCommandsChunkData = z.infer<typeof availableCommandsChunkDataSchema>

export const systemEventDataSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local_command_output'),
    text: z.string().max(50_000),
    command: z.string().max(160).optional(),
  }),
  z.object({
    kind: z.literal('status'),
    status: z.enum(['compacting', 'requesting', 'idle']),
    text: z.string().max(1_000).optional(),
    compactResult: z.enum(['success', 'failed']).optional(),
    compactError: z.string().max(2_000).optional(),
  }),
  z.object({
    kind: z.literal('compact_boundary'),
    trigger: z.enum(['manual', 'auto']).optional(),
    preTokens: z.number().int().nonnegative().optional(),
    postTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    harness: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('command_blocked'),
    command: z.string().min(1).max(160),
    originalText: z.string().max(10_000),
    validCommands: z.array(z.string().max(160)).max(100),
    reason: z.enum(['dangerous_passthrough', 'terminal_only', 'host_owned']),
  }),
  z.object({
    kind: z.literal('side_note'),
    question: z.string().max(10_000),
    answer: z.string().max(50_000).optional(),
    sideRunId: z.string().max(64).optional(),
    status: z.enum(['pending', 'answered', 'failed']),
    error: z.string().max(2_000).optional(),
  }),
])
export type SystemEventData = z.infer<typeof systemEventDataSchema>

export const STRUCTURED_MENTION_KINDS = [
  'task',
  'thread',
  'chat',
  'pr',
  'person',
  'bot',
  'file',
  'folder',
  'skill',
  'device',
  'subagent',
  'plugin',
  'slack_channel',
] as const
export type StructuredMentionKind = (typeof STRUCTURED_MENTION_KINDS)[number]

export const structuredMentionSchema = z
  .object({
    kind: z.enum(STRUCTURED_MENTION_KINDS),
    id: z.string().min(1).max(256),
    label: z.string().max(200).optional(),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .refine(value => value.end >= value.start, { message: 'Mention end must be >= start' })
export type StructuredMention = z.infer<typeof structuredMentionSchema>
export const structuredMentionsSchema = z.array(structuredMentionSchema).max(100)

// --- Claude Code blocklist & command normalization ---------------------------

/** Commands that MUST never pass through to Claude Code CLI (Issue #3333 Bug 1). */
export const CLAUDE_DANGEROUS_PASSTHROUGH_COMMANDS = [
  'login',
  'logout',
  'config',
  'model',
  'permissions',
  'mcp',
  'resume',
] as const

/** Commands owned by Mikka or terminal-only in headless/daemon Claude Code runs. */
export const CLAUDE_HOST_OWNED_COMMANDS = [
  'clear',
  'cost',
  'usage',
  'model',
  'login',
  'logout',
  'config',
  'permissions',
  'theme',
  'terminal-setup',
  'doctor',
  'keybindings-help',
  'release-notes',
  'mcp',
  'resume',
  'help',
  'exit',
  'quit',
  'vim',
  'statusline',
] as const

const DANGEROUS_SET = new Set<string>(CLAUDE_DANGEROUS_PASSTHROUGH_COMMANDS)
const HOST_OWNED_SET = new Set<string>(CLAUDE_HOST_OWNED_COMMANDS)

export function normalizeCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, '')
}

/**
 * Parse a leading slash command from a user message.
 * Only matches when `/` starts the message (after optional leading whitespace)
 * and is followed by a command token (never a multi-segment Unix file path like `/usr/bin/env`).
 */
export function parseLeadingSlashCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([A-Za-z0-9][A-Za-z0-9:_.-]*)(?:(?:[ \t\r\n]+)([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  return {
    name: match[1]!,
    args: (match[2] ?? '').trim(),
  }
}

export type BlockedCommandCheck =
  | { blocked: false }
  | { blocked: true; reason: 'dangerous_passthrough' | 'terminal_only' | 'host_owned'; canonical: string }

/**
 * Check whether a leading slash command must be blocked from passing through
 * to Claude Code CLI. Always blocks the dangerous pass-through set, any command
 * reported in `terminal_slash_commands`, and Mikka/terminal host-owned commands.
 */
export function isBlockedClaudeCommand(
  name: string,
  terminalSlashCommands?: readonly string[],
): BlockedCommandCheck {
  const canonical = normalizeCommandName(name).toLowerCase()
  if (!canonical) return { blocked: false }
  if (DANGEROUS_SET.has(canonical)) {
    return { blocked: true, reason: 'dangerous_passthrough', canonical }
  }
  if (terminalSlashCommands?.some(item => normalizeCommandName(item).toLowerCase() === canonical)) {
    return { blocked: true, reason: 'terminal_only', canonical }
  }
  if (HOST_OWNED_SET.has(canonical)) {
    return { blocked: true, reason: 'host_owned', canonical }
  }
  return { blocked: false }
}

export interface ClaudeSdkSlashCommand {
  name: string
  description?: string
  argumentHint?: string
  aliases?: readonly string[]
  builtin?: boolean
}

function classifyClaudeCommand(
  rawName: string,
  description: string,
  skillSet: ReadonlySet<string>,
): { name: string; source: AvailableCommandSource; server?: string } {
  const cleaned = normalizeCommandName(rawName)
  const lower = cleaned.toLowerCase()
  // Normalize MCP prompt naming variants into `mcp:server:prompt`
  const mcpColon = /^mcp:([^:]+):(.+)$/i.exec(cleaned)
  if (mcpColon) {
    return { name: `mcp:${mcpColon[1]}:${mcpColon[2]}`, source: 'mcp', server: mcpColon[1] }
  }
  const mcpUnderscore = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/i.exec(cleaned)
  if (mcpUnderscore) {
    return { name: `mcp:${mcpUnderscore[1]}:${mcpUnderscore[2]}`, source: 'mcp', server: mcpUnderscore[1] }
  }
  if (/\(MCP\)\s*$/i.test(description) && cleaned.includes(':')) {
    const colonIdx = cleaned.indexOf(':')
    const server = cleaned.slice(0, colonIdx)
    const prompt = cleaned.slice(colonIdx + 1)
    if (server && prompt) {
      return { name: `mcp:${server}:${prompt}`, source: 'mcp', server }
    }
  }
  if (skillSet.has(lower)) {
    return { name: cleaned, source: 'skill' }
  }
  return { name: cleaned, source: 'claude-code' }
}

/**
 * Build Mikka's `AvailableCommand[]` catalogue from Claude Code SDK `system/init`,
 * `session.supportedCommands()`, and `system/commands_changed` payloads.
 */
export function normalizeClaudeCommands(input: {
  initSlashCommands?: readonly string[]
  supportedCommands?: readonly ClaudeSdkSlashCommand[]
  terminalSlashCommands?: readonly string[]
  initSkills?: readonly string[]
}): AvailableCommand[] {
  const terminal = input.terminalSlashCommands ?? []
  const skillSet = new Set(
    (input.initSkills ?? []).map(name => normalizeCommandName(name).toLowerCase()).filter(Boolean),
  )
  const byKey = new Map<string, AvailableCommand>()

  const add = (entry: {
    name: string
    description?: string
    argumentHint?: string
    aliases?: readonly string[]
  }) => {
    const cleaned = normalizeCommandName(entry.name)
    if (!cleaned) return
    if (isBlockedClaudeCommand(cleaned, terminal).blocked) return
    const desc = (entry.description ?? '').trim()
    const classified = classifyClaudeCommand(cleaned, desc, skillSet)
    const key = classified.name.toLowerCase()
    const hint = entry.argumentHint?.trim()
    const aliases = entry.aliases
      ?.map(normalizeCommandName)
      .filter(a => a && a.toLowerCase() !== key && !isBlockedClaudeCommand(a, terminal).blocked)
    const existing = byKey.get(key)
    const cleanDesc = classified.source === 'mcp' ? desc.replace(/\s*\(MCP\)\s*$/i, '').trim() : desc
    byKey.set(key, {
      name: classified.name,
      description: cleanDesc || existing?.description || '',
      ...(hint ? { input: { hint } } : existing?.input ? { input: existing.input } : {}),
      _meta: {
        source: classified.source,
        ...(aliases?.length ? { aliases } : existing?._meta.aliases ? { aliases: existing._meta.aliases } : {}),
        ...(classified.server ? { server: classified.server } : {}),
      },
    })
  }

  for (const name of input.initSlashCommands ?? []) {
    add({ name })
  }
  for (const cmd of input.supportedCommands ?? []) {
    add(cmd)
  }
  for (const skillName of input.initSkills ?? []) {
    const cleaned = normalizeCommandName(skillName)
    if (!cleaned || byKey.has(cleaned.toLowerCase())) continue
    if (isBlockedClaudeCommand(cleaned, terminal).blocked) continue
    byKey.set(cleaned.toLowerCase(), {
      name: cleaned,
      description: '',
      _meta: { source: 'skill' },
    })
  }

  // Ensure `/compact` is always present with a sensible hint on Claude Code
  if (!byKey.has('compact')) {
    byKey.set('compact', {
      name: 'compact',
      description: 'Compact conversation history',
      input: { hint: '[instructions]' },
      _meta: { source: 'claude-code' },
    })
  } else {
    const compact = byKey.get('compact')!
    if (!compact.input) compact.input = { hint: '[instructions]' }
    if (!compact.description) compact.description = 'Compact conversation history'
  }

  return [...byKey.values()]
}

// --- Codex commands & normalization ------------------------------------------

export const CODEX_CURATED_COMMANDS: readonly AvailableCommand[] = [
  {
    name: 'review',
    description: 'Review code changes',
    input: { hint: '[instructions]' },
    _meta: { source: 'codex' },
  },
  {
    name: 'compact',
    description: 'Compact conversation history',
    _meta: { source: 'codex' },
  },
  {
    name: 'init',
    description: 'Create or update AGENTS.md',
    _meta: { source: 'codex' },
  },
]

export function normalizeCodexCommands(
  skills?: readonly { name: string; description?: string }[],
): AvailableCommand[] {
  const byKey = new Map<string, AvailableCommand>()
  for (const cmd of CODEX_CURATED_COMMANDS) {
    byKey.set(cmd.name.toLowerCase(), { ...cmd, _meta: { ...cmd._meta } })
  }
  for (const skill of skills ?? []) {
    const cleaned = normalizeCommandName(skill.name)
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (byKey.has(key)) continue
    byKey.set(key, {
      name: cleaned,
      description: (skill.description ?? '').trim(),
      _meta: { source: 'skill' },
    })
  }
  return [...byKey.values()]
}

// --- Eve commands & normalization --------------------------------------------

export const EVE_AVAILABLE_COMMANDS: readonly AvailableCommand[] = [
  {
    name: 'compact',
    description: 'Compact conversation context',
    _meta: { source: 'eve' },
  },
  {
    name: 'clear',
    description: 'Clear conversation history',
    _meta: { source: 'eve' },
  },
  {
    name: 'schedules',
    description: 'Inspect or manage schedules',
    _meta: { source: 'eve' },
  },
  {
    name: 'subagents',
    description: 'List or inspect subagents',
    _meta: { source: 'eve' },
  },
  {
    name: 'web-search',
    description: 'Search the web',
    input: { hint: '<query>' },
    _meta: { source: 'eve' },
  },
  {
    name: 'dispatch',
    description: 'Dispatch a task to a worker',
    input: { hint: '<task>' },
    _meta: { source: 'eve' },
  },
]

export function normalizeEveCommands(
  skills?: readonly { name: string; description?: string }[],
): AvailableCommand[] {
  const byKey = new Map<string, AvailableCommand>()
  for (const cmd of EVE_AVAILABLE_COMMANDS) {
    byKey.set(cmd.name.toLowerCase(), { ...cmd, _meta: { ...cmd._meta } })
  }
  for (const skill of skills ?? []) {
    const cleaned = normalizeCommandName(skill.name)
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (byKey.has(key)) continue
    byKey.set(key, {
      name: cleaned,
      description: (skill.description ?? '').trim(),
      _meta: { source: 'skill' },
    })
  }
  return [...byKey.values()]
}

// --- Mikka host commands -----------------------------------------------------

export interface HostCommandOptions {
  /** Include coding-thread controls like `/changes`, `/task`, `/machine`, `/fork`, `/side`. */
  threadSurface?: 'coding' | 'bot'
  /** Whether `/stop` is currently relevant. */
  canStop?: boolean
  /** Whether a linked task exists for `/task`. */
  hasTask?: boolean
}

export function mikkaHostCommands(options: HostCommandOptions = {}): AvailableCommand[] {
  const surface = options.threadSurface ?? 'coding'
  const base: AvailableCommand[] = [
    { name: 'new', description: 'Start a new thread', _meta: { source: 'mikka' } },
  ]
  if (surface === 'coding') {
    base.push(
      { name: 'fork', description: 'Fork full history into a new thread', _meta: { source: 'mikka' } },
      { name: 'fork-summary', description: 'Fork with a summary into a new thread', _meta: { source: 'mikka' } },
      {
        name: 'side',
        description: 'Ask a side question without interrupting',
        input: { hint: '<question>' },
        _meta: { source: 'mikka', aliases: ['btw'] },
      },
    )
  }
  if (options.canStop !== false) {
    base.push({ name: 'stop', description: 'Stop the active run', _meta: { source: 'mikka' } })
  }
  base.push(
    { name: 'model', description: 'Switch model', _meta: { source: 'mikka' } },
    {
      name: 'reasoning',
      description: 'Adjust reasoning effort',
      _meta: { source: 'mikka', aliases: ['effort'] },
    },
    { name: 'fast', description: 'Toggle Fast mode', _meta: { source: 'mikka' } },
    { name: 'ultrafast', description: 'Toggle Ultrafast mode', _meta: { source: 'mikka' } },
    { name: 'pro', description: 'Toggle Pro mode', _meta: { source: 'mikka' } },
  )
  if (surface === 'coding') {
    base.push(
      { name: 'machine', description: 'Select machine size for next run', _meta: { source: 'mikka' } },
      { name: 'tags', description: 'Manage thread tags', _meta: { source: 'mikka' } },
      { name: 'folder', description: 'Move thread to a folder', _meta: { source: 'mikka' } },
      { name: 'changes', description: 'Open changed files', _meta: { source: 'mikka' } },
    )
    if (options.hasTask) {
      base.push({ name: 'task', description: 'Open linked task', _meta: { source: 'mikka' } })
    }
  }
  base.push({ name: 'help', description: 'Show available commands', _meta: { source: 'mikka' } })
  return base
}

/**
 * Merge Mikka host commands with runtime-reported harness/skill/MCP commands.
 * Host commands always win over runtime duplicates (matching name or alias).
 */
export function mergeAvailableCommands(
  host: readonly AvailableCommand[],
  runtime: readonly AvailableCommand[],
): AvailableCommand[] {
  const claimed = new Set<string>()
  const result: AvailableCommand[] = []

  const claim = (cmd: AvailableCommand) => {
    const key = normalizeCommandName(cmd.name).toLowerCase()
    if (!key || claimed.has(key)) return false
    claimed.add(key)
    for (const alias of cmd._meta.aliases ?? []) {
      const a = normalizeCommandName(alias).toLowerCase()
      if (a) claimed.add(a)
    }
    result.push({ ...cmd, name: normalizeCommandName(cmd.name) })
    return true
  }

  for (const cmd of host) claim(cmd)
  for (const cmd of runtime) claim(cmd)
  return result
}

export type CommandSectionKey = 'mikka' | 'harness' | 'skill' | 'mcp'

export function commandSectionKey(source: AvailableCommandSource): CommandSectionKey {
  if (source === 'mikka') return 'mikka'
  if (source === 'skill') return 'skill'
  if (source === 'mcp') return 'mcp'
  return 'harness'
}

function scoreCommandMatch(cmd: AvailableCommand, needle: string): number {
  if (!needle) return 1
  const names = [cmd.name, ...(cmd._meta.aliases ?? [])].map(s => s.toLowerCase())
  let best = 0
  for (const n of names) {
    if (n === needle) best = Math.max(best, 100)
    else if (n.startsWith(needle)) best = Math.max(best, 80 - Math.min(20, n.length - needle.length))
    else if (new RegExp(`(?:^|[-_:])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) {
      best = Math.max(best, 55)
    } else if (n.includes(needle)) {
      best = Math.max(best, 35)
    }
  }
  if (best === 0 && cmd.description.toLowerCase().includes(needle)) {
    best = 15
  }
  return best
}

/**
 * Filter and rank commands by best match against a query (without leading `/`).
 */
export function rankAvailableCommands(
  commands: readonly AvailableCommand[],
  query: string,
): AvailableCommand[] {
  const needle = normalizeCommandName(query).toLowerCase()
  if (!needle) return [...commands]
  return commands
    .map((cmd, index) => ({ cmd, index, score: scoreCommandMatch(cmd, needle) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.cmd)
}

export const COMMAND_SECTION_ORDER: readonly CommandSectionKey[] = ['mikka', 'harness', 'skill', 'mcp']

export function groupAvailableCommands(
  commands: readonly AvailableCommand[],
): { section: CommandSectionKey; commands: AvailableCommand[] }[] {
  const buckets = new Map<CommandSectionKey, AvailableCommand[]>()
  for (const cmd of commands) {
    const key = commandSectionKey(cmd._meta.source)
    const list = buckets.get(key)
    if (list) list.push(cmd)
    else buckets.set(key, [cmd])
  }
  return COMMAND_SECTION_ORDER.map(section => ({
    section,
    commands: buckets.get(section) ?? [],
  })).filter(group => group.commands.length > 0)
}

// --- Bug 4: Per-harness skill mention resolution -----------------------------

const SKILL_TOKEN_RE = /(^|[^A-Za-z0-9_\\])\$([a-z][a-z0-9-]{0,63})(?![A-Za-z0-9_-])/g

export interface SkillMentionResolution {
  text: string
  skills: string[]
}

/**
 * Resolve `$skill-slug` references for the target harness:
 * - `codex`: keeps `$slug` natively as-is.
 * - `claude_code`: translates `$slug` mentions into explicit Claude Code Skill
 *   invocation instructions so skills work mid-line and when wrapped.
 * - `eve`: translates `$slug` mentions into explicit `load_skill` /
 *   `read_personal_skill` instructions.
 *
 * When `knownSkills` is supplied, only matching skill slugs are resolved so
 * ordinary shell variables like `$path` or `$home` are never touched.
 */
export function resolveSkillMentionsForHarness(
  harness: 'claude_code' | 'codex' | 'eve' | 'mock' | string,
  text: string,
  knownSkills?: readonly string[],
): SkillMentionResolution {
  const allowed = knownSkills
    ? new Set(knownSkills.map(s => normalizeCommandName(s).toLowerCase()).filter(Boolean))
    : null
  const found: string[] = []
  const seen = new Set<string>()

  const matchedText = text.replace(SKILL_TOKEN_RE, (full, prefix: string, slug: string) => {
    const lower = slug.toLowerCase()
    if (allowed && !allowed.has(lower)) return full
    if (!seen.has(lower)) {
      seen.add(lower)
      found.push(slug)
    }
    if (harness === 'claude_code') return `${prefix}/${slug}`
    return full
  })

  if (!found.length || harness === 'codex' || harness === 'mock') {
    return { text, skills: found }
  }

  if (harness === 'claude_code') {
    const list = found.map(s => `/${s}`).join(', ')
    return {
      text: `${matchedText}\n\n[Mikka skill request: invoke the Claude Code Skill tool for ${list} before proceeding.]`,
      skills: found,
    }
  }

  if (harness === 'eve') {
    const list = found.map(s => `"${s}"`).join(', ')
    return {
      text: `${text}\n\n[Mikka skill request: load and follow the requested skill(s) ${list} using load_skill or read_personal_skill before answering.]`,
      skills: found,
    }
  }

  return { text, skills: found }
}
