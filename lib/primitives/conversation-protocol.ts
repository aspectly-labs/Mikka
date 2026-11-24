/**
 * Unified Shared Conversation / Thread / Subagent Protocol Primitive.
 *
 * Aligns Mikka's four conversation surfaces — Bot DM (`bot:<id>`), Group Chat (`group:<id>`),
 * Task Thread (`thread:<id>`), and Read-Only Subagent (`subagent:<id>`) — into ONE canonical
 * typed contract modeled after OpenAI Codex's `app-server-ts` (`Thread / Turn / ThreadItem /
 * CollabAgentState`) and Orca's settled subagent view.
 *
 * Design invariants:
 * 1. Zero IO, zero server-only or Node-only imports — safe across Backend API, Web, Desktop, and iOS.
 * 2. Strict canonical IDs (`bot:<id>`, `group:<id>`, `thread:<id>`, `subagent:<id>`) prevent
 *    cross-surface prefix drift (e.g. legacy `bot-chat:` vs `bot:`).
 * 3. Decision 1 / R-10 read-only subagent invariant: `kind === 'subagent'` is enforced at both
 *    compile time (`readOnly: true`, `canReply: false`, `canRetry: false`) and runtime.
 * 4. `finishedAt` preservation across task threads and subagents eliminates null-elapsed /
 *    dangling-separator UI regressions.
 * 5. Pagination invariant: `MikkaHistoryPage.hasMore === (MikkaHistoryPage.nextBefore !== null)`.
 */

// ── 1. Conversation Kinds & Canonical Typed IDs ──────────────────────────────────────────────

export const MIKKA_CONVERSATION_KINDS = ['bot', 'group', 'thread', 'subagent'] as const
export type MikkaConversationKind = (typeof MIKKA_CONVERSATION_KINDS)[number]

export const MIKKA_CONVERSATION_PREFIXES = {
  bot: 'bot:',
  group: 'group:',
  thread: 'thread:',
  subagent: 'subagent:',
} as const satisfies Record<MikkaConversationKind, `${MikkaConversationKind}:`>

export type MikkaBotConversationId = `bot:${string}`
export type MikkaGroupConversationId = `group:${string}`
export type MikkaThreadConversationId = `thread:${string}`
export type MikkaSubagentConversationId = `subagent:${string}`

export type MikkaConversationId<K extends MikkaConversationKind = MikkaConversationKind> =
  K extends 'bot'
    ? MikkaBotConversationId
    : K extends 'group'
      ? MikkaGroupConversationId
      : K extends 'thread'
        ? MikkaThreadConversationId
        : K extends 'subagent'
          ? MikkaSubagentConversationId
          : never

export type MikkaConversationRef<K extends MikkaConversationKind = MikkaConversationKind> =
  K extends MikkaConversationKind
    ? {
        readonly kind: K
        readonly rawId: string
        readonly id: MikkaConversationId<K>
      }
    : never

const RAW_ID_MAX_LENGTH = 128
const RAW_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const KIND_SET: ReadonlySet<string> = new Set(MIKKA_CONVERSATION_KINDS)

/**
 * Validates the unprefixed entity identifier segment (UUID, ULID, slug, or `coordinator`).
 * Rejects empty strings, whitespace, colons (nested prefixes), slashes, control chars, `.` and `..`.
 */
export function isValidConversationRawId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > RAW_ID_MAX_LENGTH) return false
  if (value === '.' || value === '..') return false
  return RAW_ID_PATTERN.test(value)
}

export function isConversationKind(value: unknown): value is MikkaConversationKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

/** Formats a canonical typed conversation ID, throwing RangeError on malformed kind or rawId. */
export function formatConversationId<K extends MikkaConversationKind>(
  kind: K,
  rawId: string,
): MikkaConversationId<K> {
  if (!isConversationKind(kind)) {
    throw new RangeError(`Invalid MikkaConversationKind: ${String(kind)}`)
  }
  if (!isValidConversationRawId(rawId)) {
    throw new RangeError(`Invalid raw conversation id for kind "${kind}": ${JSON.stringify(rawId)}`)
  }
  return `${MIKKA_CONVERSATION_PREFIXES[kind]}${rawId}` as MikkaConversationId<K>
}

export const botConversationId = (botId: string): MikkaBotConversationId =>
  formatConversationId('bot', botId)

export const groupConversationId = (groupId: string): MikkaGroupConversationId =>
  formatConversationId('group', groupId)

export const threadConversationId = (runId: string): MikkaThreadConversationId =>
  formatConversationId('thread', runId)

export const subagentConversationId = (runId: string): MikkaSubagentConversationId =>
  formatConversationId('subagent', runId)

/**
 * Strictly parses a canonical `bot:<id>`, `group:<id>`, `thread:<id>`, or `subagent:<id>` identifier.
 * Rejects legacy aliases (`bot-chat:`), uppercase prefixes, whitespace, nested colons, or empty raw IDs.
 */
export function parseConversationId(value: unknown): MikkaConversationRef | null {
  if (typeof value !== 'string') return null
  const colon = value.indexOf(':')
  if (colon <= 0) return null
  const kind = value.slice(0, colon)
  if (!isConversationKind(kind)) return null
  const rawId = value.slice(colon + 1)
  if (!isValidConversationRawId(rawId)) return null
  switch (kind) {
    case 'bot':
      return { kind: 'bot', rawId, id: `bot:${rawId}` }
    case 'group':
      return { kind: 'group', rawId, id: `group:${rawId}` }
    case 'thread':
      return { kind: 'thread', rawId, id: `thread:${rawId}` }
    case 'subagent':
      return { kind: 'subagent', rawId, id: `subagent:${rawId}` }
  }
}

/** Parses a canonical conversation ID or throws RangeError. */
export function assertConversationId(value: unknown): MikkaConversationRef {
  const parsed = parseConversationId(value)
  if (!parsed) {
    throw new RangeError(`Invalid canonical MikkaConversationId: ${JSON.stringify(value)}`)
  }
  return parsed
}

export function isConversationId(value: unknown): value is MikkaConversationId {
  return parseConversationId(value) !== null
}

export function isConversationIdOfKind<K extends MikkaConversationKind>(
  value: unknown,
  kind: K,
): value is MikkaConversationId<K> {
  const parsed = parseConversationId(value)
  return parsed !== null && parsed.kind === kind
}

const LEGACY_BOT_CHAT_PREFIX = 'bot-chat:'

/**
 * Explicit migration bridge for legacy iOS `mikka-adapter` thread IDs (`bot-chat:<botId>`).
 * Accepts all canonical IDs (`bot:`, `group:`, `thread:`, `subagent:`) and converts `bot-chat:<id>`
 * into canonical `bot:<id>`. Keep strict `parseConversationId` for canonical protocol validation.
 */
export function fromLegacyAdapterThreadId(value: unknown): MikkaConversationRef | null {
  if (typeof value !== 'string') return null
  if (value.startsWith(LEGACY_BOT_CHAT_PREFIX)) {
    const rawId = value.slice(LEGACY_BOT_CHAT_PREFIX.length)
    if (!isValidConversationRawId(rawId)) return null
    return { kind: 'bot', rawId, id: botConversationId(rawId) }
  }
  return parseConversationId(value)
}

// ── 2. Canonical Statuses & Timestamps ───────────────────────────────────────────────────────

export const MIKKA_CONVERSATION_STATUSES = [
  'idle',
  'queued',
  'running',
  'waiting_input',
  'paused',
  'completed',
  'stopped',
  'failed',
] as const
export type MikkaConversationStatus = (typeof MIKKA_CONVERSATION_STATUSES)[number]

export const MIKKA_SUBAGENT_STATUSES = [
  'queued',
  'running',
  'waiting_input',
  'completed',
  'stopped',
  'failed',
] as const
export type MikkaSubagentStatus = (typeof MIKKA_SUBAGENT_STATUSES)[number]

export const MIKKA_TURN_STATUSES = ['in_progress', 'completed', 'interrupted', 'failed'] as const
export type MikkaTurnStatus = (typeof MIKKA_TURN_STATUSES)[number]

export type TimestampInput = Date | string | number | null | undefined

const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

/**
 * Normalizes a Date, ISO-8601 string, or Unix-millisecond number to an ISO-8601 string.
 * Returns `null` for nullish, empty, non-finite, or unparseable inputs.
 */
export function normalizeIsoTimestamp(value: TimestampInput): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const ms = Date.parse(trimmed)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  return null
}

/** Converts Codex-style Unix timestamps in seconds into canonical ISO-8601 strings. */
export function isoFromUnixSeconds(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

/** Computes non-negative elapsed milliseconds between two timestamps, or `null` if incomplete/invalid. */
export function computeDurationMs(
  startedAt: TimestampInput,
  finishedAt: TimestampInput,
): number | null {
  const startIso = normalizeIsoTimestamp(startedAt)
  const endIso = normalizeIsoTimestamp(finishedAt)
  if (!startIso || !endIso) return null
  const delta = Date.parse(endIso) - Date.parse(startIso)
  return Number.isFinite(delta) && delta >= 0 ? Math.round(delta) : null
}

function toTimestampMs(value: TimestampInput): number | null {
  const iso = normalizeIsoTimestamp(value)
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function isActiveConversationStatus(status: MikkaConversationStatus): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting_input' ||
    status === 'paused'
  )
}

export function isWorkingConversationStatus(status: MikkaConversationStatus): boolean {
  return status === 'queued' || status === 'running'
}

export function isTerminalConversationStatus(status: MikkaConversationStatus): boolean {
  return status === 'completed' || status === 'stopped' || status === 'failed'
}

export interface ConversationStatusInput {
  readonly status?: string | null
  readonly outcome?: string | null
  readonly stopReason?: string | null
  readonly working?: boolean
  readonly error?: string | null
}

/**
 * Maps Mikka backend run/thread/chat statuses, `MobileThreadStatus`, `RunMarkStatus`,
 * `OperationStatus`, and Codex `CollabAgentStatus`/`TurnStatus` into one canonical status.
 */
export function normalizeConversationStatus(
  input: string | ConversationStatusInput | null | undefined,
): MikkaConversationStatus {
  if (typeof input === 'string') {
    return normalizeConversationStatus({ status: input })
  }
  if (!input) return 'idle'

  const rawStatus = input.status?.trim().toLowerCase() ?? ''
  const rawOutcome = input.outcome?.trim().toLowerCase() ?? ''
  const rawStop = input.stopReason?.trim().toLowerCase() ?? ''

  if (rawStatus === 'queued' || rawStatus === 'preparing' || rawStatus === 'pendinginit' || rawStatus === 'pending_init' || rawStatus === 'submitted') {
    return 'queued'
  }
  if (
    rawStatus === 'running' ||
    rawStatus === 'working' ||
    rawStatus === 'streaming' ||
    rawStatus === 'finishing' ||
    rawStatus === 'inprogress' ||
    rawStatus === 'in_progress' ||
    rawStatus === 'active'
  ) {
    return 'running'
  }
  if (rawStatus === 'paused') return 'paused'
  if (
    rawStatus === 'waiting_input' ||
    rawStatus === 'waiting' ||
    rawStatus === 'waiting_on_you' ||
    rawStatus === 'waiting-on-you' ||
    rawStatus === 'needs_input' ||
    rawStatus === 'needs-you' ||
    rawStatus === 'needs_you' ||
    rawStatus === 'awaiting_input'
  ) {
    return 'waiting_input'
  }
  if (
    rawStatus === 'failed' ||
    rawStatus === 'error' ||
    rawStatus === 'errored' ||
    rawStatus === 'blocked' ||
    rawStatus === 'systemerror' ||
    rawStatus === 'system_error'
  ) {
    return 'failed'
  }
  if (
    rawStatus === 'stopped' ||
    rawStatus === 'cancelled' ||
    rawStatus === 'canceled' ||
    rawStatus === 'interrupted' ||
    rawStatus === 'shutdown'
  ) {
    if (!rawOutcome && rawStop === 'asked_human') return 'waiting_input'
    return 'stopped'
  }
  if (rawStatus === 'succeeded' || rawStatus === 'completed' || rawStatus === 'done') {
    if (rawOutcome === 'failed' || rawOutcome === 'blocked') return 'failed'
    if (rawOutcome === 'needs_input') return 'waiting_input'
    if (!rawOutcome && rawStop === 'asked_human') return 'waiting_input'
    return 'completed'
  }

  if (input.working === true) return 'running'
  if (input.error && input.error.trim().length > 0) return 'failed'
  return 'idle'
}

/** Normalizes any run/collab status into the closed `MikkaSubagentStatus` subset. */
export function normalizeSubagentStatus(
  input: ConversationStatusInput & { readonly finishedAt?: TimestampInput },
): MikkaSubagentStatus {
  const status = normalizeConversationStatus(input)
  switch (status) {
    case 'queued':
    case 'running':
    case 'waiting_input':
    case 'completed':
    case 'stopped':
    case 'failed':
      return status
    case 'paused':
      return 'waiting_input'
    case 'idle':
      return normalizeIsoTimestamp(input.finishedAt) ? 'completed' : 'queued'
  }
}

// ── 3. Unified Conversation Shell (Discriminated Union) ──────────────────────────────────────

export interface MikkaConversationShellBase {
  readonly title: string
  readonly status: MikkaConversationStatus
  readonly createdAt: string | null
  readonly updatedAt: string
  /** Completion timestamp (ISO-8601), preserved on settled threads and subagents (Evidence A). */
  readonly finishedAt?: string | null
  /** Linked task/issue UUID when this thread/subagent works on a task. */
  readonly issueId?: string | null
  /** Canonical parent conversation ID (`thread:<id>` or `bot:<id>`) for child/subagent lineage. */
  readonly parentThreadId?: MikkaConversationId | null
  readonly preview?: string | null
  readonly unreadCount?: number
  readonly pinned?: boolean
  readonly archived?: boolean
}

export interface MikkaBotConversationShell extends MikkaConversationShellBase {
  readonly kind: 'bot'
  readonly id: MikkaBotConversationId
  readonly rawId: string
  readonly readOnly: boolean
  readonly canReply: boolean
  readonly canRetry: boolean
  readonly coordinator?: boolean
  readonly color?: string | null
  readonly shape?: string | null
}

export interface MikkaGroupConversationShell extends MikkaConversationShellBase {
  readonly kind: 'group'
  readonly id: MikkaGroupConversationId
  readonly rawId: string
  readonly readOnly: boolean
  readonly canReply: boolean
  readonly canRetry: false
  readonly workspaceId?: string | null
  readonly memberCount?: number
}

export interface MikkaThreadConversationShell extends MikkaConversationShellBase {
  readonly kind: 'thread'
  readonly id: MikkaThreadConversationId
  readonly rawId: string
  /** Newest run in the thread chain where replies and stop commands route. */
  readonly liveRunId: string
  readonly readOnly: boolean
  readonly canReply: boolean
  readonly canRetry: false
  readonly harness?: string | null
  readonly model?: string | null
  readonly dispatchedBy?: string | null
}

/**
 * Decision 1 / R-10 read-only subagent shell contract:
 * Subagents are observe-only for humans (`readOnly: true`, `canReply: false`, `canRetry: false`).
 * Enforced both statically via literal types and dynamically via `normalizeSubagentShell`.
 */
export interface MikkaSubagentConversationShell extends MikkaConversationShellBase {
  readonly kind: 'subagent'
  readonly id: MikkaSubagentConversationId
  readonly rawId: string
  readonly latestRunId: string
  readonly readOnly: true
  readonly canReply: false
  readonly canRetry: false
  readonly parentThreadId: MikkaConversationId | null
  readonly finishedAt: string | null
  readonly harness?: string | null
  readonly model?: string | null
  readonly agentRole?: string | null
  readonly brief?: string | null
  readonly profile?: { readonly name: string; readonly icon: string; readonly color: string } | null
}

export type MikkaConversationShell =
  | MikkaBotConversationShell
  | MikkaGroupConversationShell
  | MikkaThreadConversationShell
  | MikkaSubagentConversationShell

export function isSubagentShell(
  shell: MikkaConversationShell,
): shell is MikkaSubagentConversationShell {
  return shell.kind === 'subagent'
}

export function isReadOnlyConversation(shell: Pick<MikkaConversationShell, 'kind' | 'readOnly' | 'canReply'>): boolean {
  return shell.kind === 'subagent' || shell.readOnly || !shell.canReply
}

/**
 * Runtime invariant checker for any `MikkaConversationShell`.
 * Throws Error if ID/kind drift, subagent mutability, readOnly/canReply contradiction,
 * malformed `parentThreadId`, or invalid timestamps are detected.
 */
export function assertConversationShellInvariants(shell: MikkaConversationShell): void {
  const parsed = parseConversationId(shell.id)
  if (!parsed) {
    throw new Error(`Shell id is not a valid canonical MikkaConversationId: ${JSON.stringify(shell.id)}`)
  }
  if (parsed.kind !== shell.kind || parsed.rawId !== shell.rawId) {
    throw new Error(
      `Shell id "${shell.id}" disagrees with kind="${shell.kind}" rawId="${shell.rawId}"`,
    )
  }
  if (shell.kind === 'subagent') {
    if (shell.readOnly !== true || shell.canReply !== false || shell.canRetry !== false) {
      throw new Error(
        `Subagent shell "${shell.id}" violated Decision 1 / R-10 read-only invariant`,
      )
    }
  }
  if (shell.readOnly && shell.canReply) {
    throw new Error(`Shell "${shell.id}" cannot have both readOnly=true and canReply=true`)
  }
  if (shell.parentThreadId !== undefined && shell.parentThreadId !== null) {
    if (!isConversationId(shell.parentThreadId)) {
      throw new Error(
        `Shell "${shell.id}" has invalid canonical parentThreadId: ${JSON.stringify(shell.parentThreadId)}`,
      )
    }
  }
  if (!normalizeIsoTimestamp(shell.updatedAt)) {
    throw new Error(`Shell "${shell.id}" has invalid updatedAt: ${JSON.stringify(shell.updatedAt)}`)
  }
  if (shell.finishedAt !== undefined && shell.finishedAt !== null && !normalizeIsoTimestamp(shell.finishedAt)) {
    throw new Error(`Shell "${shell.id}" has invalid finishedAt: ${JSON.stringify(shell.finishedAt)}`)
  }
}

export interface MikkaConversationShellCollection {
  readonly items: readonly MikkaConversationShell[]
  readonly byId: Readonly<Record<string, MikkaConversationShell>>
  readonly counts: Readonly<Record<MikkaConversationKind, number>>
}

/**
 * Builds one deduplicated, deterministically ordered shell collection across ALL 4 conversation kinds
 * (`bot`, `group`, `thread`, `subagent`) so no surface can accidentally omit `group:` or `thread:` shells.
 */
export function buildConversationShellCollection(
  shells: readonly MikkaConversationShell[],
): MikkaConversationShellCollection {
  const map = new Map<MikkaConversationId, MikkaConversationShell>()
  for (const shell of shells) {
    assertConversationShellInvariants(shell)
    map.set(shell.id, shell)
  }

  const items = [...map.values()].sort((a, b) => {
    const pinnedDelta = Number(b.pinned === true) - Number(a.pinned === true)
    if (pinnedDelta !== 0) return pinnedDelta
    const timeDelta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta
    return a.id.localeCompare(b.id)
  })

  const counts: Record<MikkaConversationKind, number> = {
    bot: 0,
    group: 0,
    thread: 0,
    subagent: 0,
  }
  const byId: Record<string, MikkaConversationShell> = {}
  for (const item of items) {
    counts[item.kind] += 1
    byId[item.id] = item
  }

  return { items, byId, counts }
}

export function filterShellsByKind<K extends MikkaConversationKind>(
  shells: readonly MikkaConversationShell[],
  kind: K,
): Extract<MikkaConversationShell, { readonly kind: K }>[] {
  return shells.filter(
    (shell): shell is Extract<MikkaConversationShell, { readonly kind: K }> => shell.kind === kind,
  )
}

// ── 4. Canonical Protocol Turns & Items ──────────────────────────────────────────────────────

export const MIKKA_PROTOCOL_ITEM_TYPES = [
  'message',
  'tool',
  'approval',
  'question',
  'subagent_summary',
  'status_notice',
] as const
export type MikkaProtocolItemType = (typeof MIKKA_PROTOCOL_ITEM_TYPES)[number]

export interface MikkaProtocolItemBase {
  readonly id: string
  readonly conversationId?: MikkaConversationId
  readonly turnId?: string | null
  /** Monotonic ordering cursor (stringified bigint for group chats, numeric string for bot chats). */
  readonly position?: string | null
  readonly createdAt: string
  readonly startedAtMs?: number | null
  readonly completedAtMs?: number | null
}

export type MikkaMessageRole = 'user' | 'assistant' | 'system'

export interface MikkaSpeaker {
  readonly kind: 'person' | 'bot' | 'agent' | 'system'
  readonly id: string
  readonly name: string
  readonly avatarUrl?: string | null
  readonly color?: string | null
  readonly shape?: string | null
}

export interface MikkaMessageItem extends MikkaProtocolItemBase {
  readonly type: 'message'
  readonly role: MikkaMessageRole
  readonly text: string
  readonly mine: boolean
  readonly speaker?: MikkaSpeaker | null
  readonly submissionId?: string | null
  readonly streamId?: string | null
  readonly pending?: boolean
  readonly streaming?: boolean
  readonly stopped?: boolean
  readonly dispatchedThreads?: readonly MikkaThreadConversationId[]
  readonly artifactIds?: readonly string[]
  readonly replyToId?: string | null
  readonly imageCount?: number
}

export const MIKKA_TOOL_KINDS = [
  'read',
  'search',
  'shell',
  'edit',
  'web',
  'delegate',
  'todo',
  'other',
] as const
export type MikkaToolKind = (typeof MIKKA_TOOL_KINDS)[number]

export const MIKKA_TOOL_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const
export type MikkaToolStatus = (typeof MIKKA_TOOL_STATUSES)[number]

export interface MikkaToolItem extends MikkaProtocolItemBase {
  readonly type: 'tool'
  readonly callId: string
  readonly name: string
  readonly displayName?: string | null
  readonly kind: MikkaToolKind
  readonly status: MikkaToolStatus
  readonly target?: string | null
  readonly scope?: string | null
  readonly detail?: string | null
  readonly command?: string | null
  readonly output?: string | null
  readonly outputTruncated?: boolean
  readonly exitCode?: number | null
  readonly durationMs?: number | null
}

export type MikkaApprovalSource = 'pending-action' | 'factory' | 'eve'
export type MikkaApprovalStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'expired'
  | 'executed'
  | 'failed'

export interface MikkaApprovalItem extends MikkaProtocolItemBase {
  readonly type: 'approval'
  readonly approvalId: string
  readonly source: MikkaApprovalSource
  readonly action: string
  readonly title: string
  readonly status: MikkaApprovalStatus
  readonly summary?: string | null
  readonly details?: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly canLater?: boolean
  readonly canDismiss?: boolean
}

export type MikkaQuestionStatus = 'pending' | 'answered' | 'dismissed' | 'stale'

export interface MikkaQuestionOption {
  readonly id: string
  readonly title: string
  readonly description?: string | null
  readonly recommended?: boolean
}

export interface MikkaQuestionPrompt {
  readonly id: string
  readonly question: string
  readonly options: readonly MikkaQuestionOption[]
  readonly multiSelect?: boolean
  readonly allowFreeform?: boolean
  readonly recordedAnswer?: string | null
}

export interface MikkaQuestionItem extends MikkaProtocolItemBase {
  readonly type: 'question'
  readonly questionGroupId: string
  readonly status: MikkaQuestionStatus
  readonly prompts: readonly MikkaQuestionPrompt[]
  readonly taskId?: string | null
  readonly taskTitle?: string | null
  readonly canLater?: boolean
  readonly canDismiss?: boolean
}

/**
 * Inline summary of a spawned subagent inside a parent conversation (Codex `collabAgentToolCall` /
 * `CollabAgentState` + Orca `AgentChildWorkView`). Carries frozen `finishedAt` & `durationMs`
 * and enforces read-only target semantics.
 */
export interface MikkaSubagentSummaryItem extends MikkaProtocolItemBase {
  readonly type: 'subagent_summary'
  readonly subagentId: MikkaSubagentConversationId
  readonly rawRunId: string
  readonly latestRunId: string
  readonly parentThreadId: MikkaConversationId | null
  readonly name: string
  readonly status: MikkaSubagentStatus
  readonly readOnly: true
  readonly canReply: false
  readonly harness?: string | null
  readonly model?: string | null
  readonly agentRole?: string | null
  readonly brief?: string | null
  readonly summary?: string | null
  readonly profile?: { readonly icon: string; readonly color: string } | null
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly durationMs: number | null
}

export type MikkaNoticeLevel = 'info' | 'warning' | 'error' | 'success'
export type MikkaNoticeKind =
  | 'error'
  | 'quota'
  | 'model_fallback'
  | 'env'
  | 'login'
  | 'stage'
  | 'computer'
  | 'agent_exchange'
  | 'event'
  | 'system'

export interface MikkaStatusNoticeItem extends MikkaProtocolItemBase {
  readonly type: 'status_notice'
  readonly noticeKind: MikkaNoticeKind
  readonly level: MikkaNoticeLevel
  readonly text: string
  readonly code?: string | null
  readonly detail?: string | null
  readonly meta?: Readonly<Record<string, unknown>>
}

export type MikkaProtocolItem =
  | MikkaMessageItem
  | MikkaToolItem
  | MikkaApprovalItem
  | MikkaQuestionItem
  | MikkaSubagentSummaryItem
  | MikkaStatusNoticeItem

export interface MikkaProtocolTurnError {
  readonly message: string
  readonly code?: string | null
}

/** Canonical turn grouping modeled after Codex `v2/Turn.ts`. */
export interface MikkaProtocolTurn {
  readonly id: string
  readonly conversationId: MikkaConversationId
  readonly rootTurnId: string | null
  readonly status: MikkaTurnStatus
  readonly items: readonly MikkaProtocolItem[]
  readonly error: MikkaProtocolTurnError | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly durationMs: number | null
}

export interface GroupItemsIntoTurnsOptions {
  readonly rootTurnId?: string | null
  readonly working?: boolean
  readonly conversationStatus?: MikkaConversationStatus
}

/**
 * Groups a chronological item stream into canonical `MikkaProtocolTurn[]`:
 * each viewer user message starts a new turn; any items preceding the first user message
 * form an opening turn (`<conversationId>:turn:0`).
 */
export function groupItemsIntoTurns(
  conversationId: MikkaConversationId,
  items: readonly MikkaProtocolItem[],
  options: GroupItemsIntoTurnsOptions = {},
): MikkaProtocolTurn[] {
  assertConversationId(conversationId)
  if (items.length === 0) return []

  const buckets: MikkaProtocolItem[][] = []
  let current: MikkaProtocolItem[] = []

  for (const item of items) {
    const startsNewTurn = item.type === 'message' && item.role === 'user' && item.mine
    if (startsNewTurn && current.length > 0) {
      buckets.push(current)
      current = [item]
    } else {
      current.push(item)
    }
  }
  if (current.length > 0) buckets.push(current)

  const rootTurnId = options.rootTurnId ?? null
  const activeTail =
    options.working === true ||
    (options.conversationStatus !== undefined && isWorkingConversationStatus(options.conversationStatus))

  return buckets.flatMap((bucket, index): MikkaProtocolTurn[] => {
    const first = bucket[0]
    const last = bucket[bucket.length - 1]
    if (!first || !last) return []
    const isLast = index === buckets.length - 1
    const turnId = first.turnId ?? `${conversationId}:turn:${index}:${first.id}`

    const errorNotice = [...bucket]
      .reverse()
      .find(
        (item): item is MikkaStatusNoticeItem =>
          item.type === 'status_notice' && item.level === 'error',
      )
    const hasStoppedReply = bucket.some((item) => item.type === 'message' && item.stopped === true)
    const hasStreamingOrPending = bucket.some(
      (item) =>
        (item.type === 'message' && (item.streaming === true || item.pending === true)) ||
        (item.type === 'tool' && item.status === 'running'),
    )

    let status: MikkaTurnStatus
    if (isLast && (activeTail || hasStreamingOrPending)) {
      status = 'in_progress'
    } else if (errorNotice) {
      status = 'failed'
    } else if (hasStoppedReply || (isLast && options.conversationStatus === 'stopped')) {
      status = 'interrupted'
    } else if (isLast && options.conversationStatus === 'failed') {
      status = 'failed'
    } else {
      status = 'completed'
    }

    const startedAt = normalizeIsoTimestamp(first.startedAtMs ?? first.createdAt)
    const completedAt =
      status === 'in_progress'
        ? null
        : normalizeIsoTimestamp(last.completedAtMs ?? last.createdAt)
    const durationMs = computeDurationMs(startedAt, completedAt)

    return [
      {
        id: turnId,
        conversationId,
        rootTurnId,
        status,
        items: bucket.map((item) => ({ ...item, conversationId: item.conversationId ?? conversationId, turnId })),
        error: errorNotice ? { message: errorNotice.text, code: errorNotice.code ?? null } : null,
        startedAt,
        completedAt,
        durationMs,
      },
    ]
  })
}

// ── 5. Canonical History Pagination ──────────────────────────────────────────────────────────

export interface MikkaHistoryPage<T = MikkaProtocolItem> {
  /** Items in canonical chronological order (oldest first, newest last). */
  readonly items: readonly T[]
  /** Strictly guaranteed to equal `nextBefore !== null`. */
  readonly hasMore: boolean
  /** Opaque cursor for loading the next older page (`before` / `through`), or `null` when exhausted. */
  readonly nextBefore: string | null
  /** Optional total item count across all pages when reported by the backend. */
  readonly totalItems?: number
}

export type RawHistoryCursor = string | number | bigint | null | undefined

/**
 * Normalizes a raw pagination cursor (`string`, positive integer `number`, or positive `bigint`)
 * into a trimmed non-empty cursor string, or `null` when exhausted/invalid.
 */
export function normalizeHistoryCursor(value: RawHistoryCursor): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') {
    return value > 0n ? value.toString() : null
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^-?\d+$/.test(trimmed) && (trimmed.startsWith('-') || /^0+$/.test(trimmed))) return null
    return trimmed
  }
  return null
}

export interface NormalizeHistoryPageInput<T> {
  readonly items: readonly T[]
  readonly nextBefore?: RawHistoryCursor
  readonly hasMore?: boolean
  readonly totalItems?: number | null
}

/**
 * Constructs a `MikkaHistoryPage<T>` enforcing strict cursor invariants:
 * - `hasMore === false` clears any stale `nextBefore` to `null`.
 * - `nextBefore === null` forces `hasMore` to `false`.
 * - `totalItems`, when valid, is guaranteed to be an integer `>= items.length`.
 */
export function normalizeHistoryPage<T>(input: NormalizeHistoryPageInput<T>): MikkaHistoryPage<T> {
  const items = [...input.items]
  const rawCursor = normalizeHistoryCursor(input.nextBefore)
  const nextBefore = input.hasMore === false ? null : rawCursor
  const hasMore = nextBefore !== null

  const totalItems =
    typeof input.totalItems === 'number' &&
    Number.isFinite(input.totalItems) &&
    input.totalItems >= 0
      ? Math.max(items.length, Math.trunc(input.totalItems))
      : undefined

  return totalItems !== undefined
    ? { items, hasMore, nextBefore, totalItems }
    : { items, hasMore, nextBefore }
}

/** Runtime assertion verifying pagination cursor invariants on any `MikkaHistoryPage`. */
export function assertHistoryPageInvariants<T>(page: MikkaHistoryPage<T>): void {
  const validCursor = page.nextBefore !== null && page.nextBefore.trim().length > 0
  if (page.hasMore !== validCursor) {
    throw new Error(
      `Pagination invariant violated: hasMore=${String(page.hasMore)} with nextBefore=${JSON.stringify(page.nextBefore)}`,
    )
  }
  if (page.nextBefore !== null && page.nextBefore !== page.nextBefore.trim()) {
    throw new Error(`Pagination cursor must be trimmed: ${JSON.stringify(page.nextBefore)}`)
  }
  if (
    page.totalItems !== undefined &&
    (!Number.isInteger(page.totalItems) || page.totalItems < page.items.length)
  ) {
    throw new Error(
      `Pagination totalItems (${String(page.totalItems)}) must be an integer >= items.length (${page.items.length})`,
    )
  }
}

/**
 * Merges an older page before a newer page in chronological order, deduplicating by `item.id`
 * (preferring the newer copy on overlap) and keeping `older`'s `nextBefore` / `hasMore` boundary.
 */
export function mergeHistoryPages<T extends { readonly id: string }>(
  older: MikkaHistoryPage<T>,
  newer: MikkaHistoryPage<T>,
): MikkaHistoryPage<T> {
  assertHistoryPageInvariants(older)
  assertHistoryPageInvariants(newer)

  const newerIds = new Set(newer.items.map((item) => item.id))
  const combined = [...older.items.filter((item) => !newerIds.has(item.id)), ...newer.items]
  const totalCandidates = [older.totalItems, newer.totalItems].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  const totalItems =
    totalCandidates.length > 0 ? Math.max(combined.length, ...totalCandidates) : undefined

  return normalizeHistoryPage({
    items: combined,
    hasMore: older.hasMore,
    nextBefore: older.nextBefore,
    totalItems,
  })
}

// ── 6. Shared Item Normalizers (Approval & Question) ─────────────────────────────────────────

export interface ApprovalItemInput {
  readonly id: string
  readonly conversationId?: MikkaConversationId
  readonly source?: MikkaApprovalSource
  readonly action: string
  readonly title?: string | null
  readonly status?: string | null
  readonly summary?: string | null
  readonly context?: { readonly summary?: string; readonly start?: string; readonly end?: string } | null
  readonly details?: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly createdAt?: TimestampInput
  readonly canLater?: boolean
  readonly canDismiss?: boolean
}

function normalizeApprovalStatus(status: string | null | undefined): MikkaApprovalStatus {
  const normalized = status?.trim().toLowerCase() ?? 'pending'
  switch (normalized) {
    case 'approved':
      return 'approved'
    case 'declined':
    case 'denied':
    case 'rejected':
    case 'cancelled':
    case 'canceled':
      return 'declined'
    case 'expired':
      return 'expired'
    case 'executed':
    case 'completed':
    case 'succeeded':
      return 'executed'
    case 'failed':
    case 'error':
      return 'failed'
    default:
      return 'pending'
  }
}

export function normalizeApprovalItem(input: ApprovalItemInput): MikkaApprovalItem {
  const createdAt = normalizeIsoTimestamp(input.createdAt) ?? EPOCH_ISO
  const summary = input.summary?.trim() || input.context?.summary?.trim() || null
  return {
    type: 'approval',
    id: `approval:${input.id}`,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    approvalId: input.id,
    source: input.source ?? 'pending-action',
    action: input.action,
    title: input.title?.trim() || input.action,
    status: normalizeApprovalStatus(input.status),
    summary,
    ...(input.details && input.details.length > 0 ? { details: [...input.details] } : {}),
    ...(input.canLater !== undefined ? { canLater: input.canLater } : {}),
    ...(input.canDismiss !== undefined ? { canDismiss: input.canDismiss } : {}),
    createdAt,
  }
}

export interface QuestionPromptInput {
  readonly id: string
  readonly question: string
  readonly options?: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description?: string | null
    readonly recommended?: boolean
  }>
  readonly multiSelect?: boolean
  readonly allowFreeform?: boolean
  readonly recordedAnswer?: string | null
}

export interface QuestionItemInput {
  readonly id: string
  readonly conversationId?: MikkaConversationId
  readonly status?: MikkaQuestionStatus
  readonly prompts: readonly QuestionPromptInput[]
  readonly taskId?: string | null
  readonly taskTitle?: string | null
  readonly createdAt?: TimestampInput
  readonly canLater?: boolean
  readonly canDismiss?: boolean
}

export function normalizeQuestionItem(input: QuestionItemInput): MikkaQuestionItem {
  const createdAt = normalizeIsoTimestamp(input.createdAt) ?? EPOCH_ISO
  return {
    type: 'question',
    id: `question:${input.id}`,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    questionGroupId: input.id,
    status: input.status ?? 'pending',
    prompts: input.prompts.map((prompt) => ({
      id: prompt.id,
      question: prompt.question,
      options: (prompt.options ?? []).map((opt) => ({
        id: opt.id,
        title: opt.title,
        ...(opt.description !== undefined ? { description: opt.description } : {}),
        ...(opt.recommended !== undefined ? { recommended: opt.recommended } : {}),
      })),
      ...(prompt.multiSelect !== undefined ? { multiSelect: prompt.multiSelect } : {}),
      ...(prompt.allowFreeform !== undefined ? { allowFreeform: prompt.allowFreeform } : {}),
      ...(prompt.recordedAnswer !== undefined ? { recordedAnswer: prompt.recordedAnswer } : {}),
    })),
    taskId: input.taskId ?? null,
    taskTitle: input.taskTitle ?? null,
    ...(input.canLater !== undefined ? { canLater: input.canLater } : {}),
    ...(input.canDismiss !== undefined ? { canDismiss: input.canDismiss } : {}),
    createdAt,
  }
}

// ── 7. Pure Normalizers: Bot DM ──────────────────────────────────────────────────────────────

export interface BotShellInput {
  readonly id: string
  readonly name?: string | null
  readonly title?: string | null
  readonly working?: boolean
  readonly status?: string | null
  readonly error?: string | null
  readonly line?: string | null
  readonly preview?: string | null
  readonly at?: TimestampInput
  readonly createdAt?: TimestampInput
  readonly updatedAt?: TimestampInput
  readonly unreadCount?: number | string | null
  readonly pinned?: boolean
  readonly archived?: boolean
  readonly coordinator?: boolean
  readonly color?: string | null
  readonly shape?: string | null
  readonly readOnly?: boolean
  readonly canReply?: boolean
  readonly canRetry?: boolean
}

function normalizeCount(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : undefined
}

export function normalizeBotShell(input: BotShellInput): MikkaBotConversationShell {
  const id = botConversationId(input.id)
  const readOnly = input.readOnly === true || input.canReply === false
  const canReply = !readOnly
  const canRetry = canReply && input.canRetry !== false
  const createdAt = normalizeIsoTimestamp(input.createdAt ?? input.at)
  const updatedAt =
    normalizeIsoTimestamp(input.updatedAt) ??
    normalizeIsoTimestamp(input.at) ??
    createdAt ??
    EPOCH_ISO
  const status = normalizeConversationStatus({
    status: input.status,
    working: input.working,
    error: input.error,
  })
  const unreadCount = normalizeCount(input.unreadCount)

  return {
    kind: 'bot',
    id,
    rawId: input.id,
    title: input.title?.trim() || input.name?.trim() || 'Bot',
    status,
    readOnly,
    canReply,
    canRetry,
    createdAt,
    updatedAt,
    finishedAt: null,
    issueId: null,
    parentThreadId: null,
    preview: input.preview ?? input.line ?? null,
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.archived !== undefined ? { archived: input.archived } : {}),
    ...(input.coordinator !== undefined ? { coordinator: input.coordinator } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.shape !== undefined ? { shape: input.shape } : {}),
  }
}

export interface BotChatToolInput {
  readonly call: string
  readonly name: string
  readonly state: 'running' | 'done' | 'error' | string
  readonly displayName?: string | null
  readonly target?: string | null
}

export interface BotChatItemInput {
  readonly id?: string | null
  readonly submissionId?: string | null
  readonly position: number
  readonly from: 'person' | 'coordinator' | 'event'
  readonly text: string
  readonly createdAt: TimestampInput
  readonly pending?: boolean
  readonly stopped?: boolean
  readonly welcome?: boolean
  readonly streamId?: string | null
  readonly images?: number
  readonly tools?: readonly string[]
  readonly threads?: readonly string[]
  readonly artifacts?: readonly string[]
  readonly activity?: {
    readonly tools?: readonly BotChatToolInput[]
    readonly thought?: boolean
  } | null
  readonly failure?: { readonly code?: string; readonly detail?: string; readonly text?: string } | unknown
  readonly line?: { readonly kind?: string; readonly [key: string]: unknown } | null
  readonly notice?: { readonly kind?: string; readonly [key: string]: unknown } | null
}

export interface BotHistoryInput {
  readonly items: readonly BotChatItemInput[]
  readonly historyBefore?: number | string | null
  readonly totalItems?: number | null
  readonly approvals?: readonly ApprovalItemInput[]
  readonly questions?: readonly QuestionItemInput[]
  readonly botSpeaker?: Omit<MikkaSpeaker, 'kind'> | null
}

const TOOL_KIND_SET: ReadonlySet<string> = new Set(MIKKA_TOOL_KINDS)

function normalizeToolKind(value: string | null | undefined): MikkaToolKind {
  const lower = value?.trim().toLowerCase() ?? ''
  return TOOL_KIND_SET.has(lower) ? (lower as MikkaToolKind) : 'other'
}

function normalizeBotToolStatus(state: string): MikkaToolStatus {
  switch (state.trim().toLowerCase()) {
    case 'running':
      return 'running'
    case 'error':
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return 'completed'
  }
}

function extractFailureNotice(failure: unknown): { text: string; code: string | null } | null {
  if (!failure) return null
  if (typeof failure === 'string' && failure.trim()) {
    return { text: failure.trim(), code: null }
  }
  if (typeof failure === 'object' && !Array.isArray(failure)) {
    const rec = failure as Record<string, unknown>
    const code = typeof rec.code === 'string' && rec.code.trim() ? rec.code.trim() : null
    const text =
      (typeof rec.text === 'string' && rec.text.trim()) ||
      (typeof rec.message === 'string' && rec.message.trim()) ||
      (typeof rec.detail === 'string' && rec.detail.trim()) ||
      code ||
      'Turn failed'
    return { text, code }
  }
  return { text: 'Turn failed', code: null }
}

function safeThreadIdList(ids: readonly string[] | undefined): MikkaThreadConversationId[] | undefined {
  if (!ids || ids.length === 0) return undefined
  const mapped: MikkaThreadConversationId[] = []
  for (const runId of ids) {
    if (isValidConversationRawId(runId)) {
      mapped.push(threadConversationId(runId))
    } else {
      const parsed = parseConversationId(runId)
      if (parsed?.kind === 'thread') mapped.push(parsed.id)
    }
  }
  return mapped.length > 0 ? mapped : undefined
}

export function normalizeBotHistoryPage(
  botId: string,
  input: BotHistoryInput,
): MikkaHistoryPage<MikkaProtocolItem> {
  const conversationId = botConversationId(botId)
  const items: MikkaProtocolItem[] = []
  const botSpeaker: MikkaSpeaker | null = input.botSpeaker
    ? { kind: 'bot', ...input.botSpeaker }
    : null

  for (const row of input.items) {
    const key = row.id ?? row.submissionId ?? `${row.position}:${row.from}`
    const createdAt = normalizeIsoTimestamp(row.createdAt) ?? EPOCH_ISO
    const createdAtMs = toTimestampMs(createdAt)
    const position = Number.isFinite(row.position) ? String(row.position) : null

    if (row.welcome === true && !row.failure && !row.text.trim()) {
      continue
    }

    if (row.from === 'event') {
      const noticeKind: MikkaNoticeKind = row.notice ? 'model_fallback' : 'event'
      items.push({
        type: 'status_notice',
        id: `event:${key}`,
        conversationId,
        position,
        createdAt,
        startedAtMs: createdAtMs,
        completedAtMs: createdAtMs,
        noticeKind,
        level: 'info',
        text: row.text,
        code: typeof row.line?.kind === 'string' ? row.line.kind : null,
        ...(row.line ? { meta: row.line } : row.notice ? { meta: row.notice } : {}),
      })
      continue
    }

    if (row.from === 'person') {
      items.push({
        type: 'message',
        id: key,
        conversationId,
        position,
        createdAt,
        startedAtMs: createdAtMs,
        completedAtMs: row.pending ? null : createdAtMs,
        role: 'user',
        text: row.text,
        mine: true,
        submissionId: row.submissionId ?? null,
        ...(row.pending === true ? { pending: true } : {}),
        ...(typeof row.images === 'number' && row.images > 0 ? { imageCount: row.images } : {}),
      })
      const failure = extractFailureNotice(row.failure)
      if (failure) {
        items.push({
          type: 'status_notice',
          id: `failure:${key}`,
          conversationId,
          position,
          createdAt,
          startedAtMs: createdAtMs,
          completedAtMs: createdAtMs,
          noticeKind: 'error',
          level: 'error',
          text: failure.text,
          code: failure.code,
        })
      }
      continue
    }

    // Coordinator / Bot reply: emit structured tools before the reply prose (matching iOS & Web ordering).
    const activityTools: readonly BotChatToolInput[] =
      row.activity?.tools && row.activity.tools.length > 0
        ? row.activity.tools
        : (row.tools ?? []).map((name, toolIndex) => ({
            call: `${key}:legacy-tool:${toolIndex}`,
            name,
            state: 'done',
          }))
    for (const [toolIndex, tool] of activityTools.entries()) {
      const toolStatus = normalizeBotToolStatus(tool.state)
      items.push({
        type: 'tool',
        id: `tool:${key}:${tool.call || toolIndex}`,
        conversationId,
        position,
        createdAt,
        startedAtMs: createdAtMs,
        completedAtMs: toolStatus === 'running' ? null : createdAtMs,
        callId: tool.call || `${key}:tool:${toolIndex}`,
        name: tool.name,
        displayName: tool.displayName ?? null,
        kind: 'other',
        status: toolStatus,
        target: tool.target ?? null,
      })
    }

    const dispatchedThreads = safeThreadIdList(row.threads)
    const artifactIds = row.artifacts && row.artifacts.length > 0 ? [...row.artifacts] : undefined
    const hasReplyContent =
      row.text.trim().length > 0 ||
      (dispatchedThreads !== undefined && dispatchedThreads.length > 0) ||
      (artifactIds !== undefined && artifactIds.length > 0) ||
      row.stopped === true

    if (hasReplyContent) {
      items.push({
        type: 'message',
        id: key,
        conversationId,
        position,
        createdAt,
        startedAtMs: createdAtMs,
        completedAtMs: createdAtMs,
        role: 'assistant',
        text: row.text,
        mine: false,
        ...(botSpeaker ? { speaker: botSpeaker } : {}),
        streamId: row.streamId ?? null,
        ...(row.stopped === true ? { stopped: true } : {}),
        ...(dispatchedThreads ? { dispatchedThreads } : {}),
        ...(artifactIds ? { artifactIds } : {}),
      })
    }

    const failure = extractFailureNotice(row.failure)
    if (failure) {
      items.push({
        type: 'status_notice',
        id: `failure:${key}`,
        conversationId,
        position,
        createdAt,
        startedAtMs: createdAtMs,
        completedAtMs: createdAtMs,
        noticeKind: 'error',
        level: 'error',
        text: failure.text,
        code: failure.code,
      })
    }
  }

  for (const approval of input.approvals ?? []) {
    items.push(normalizeApprovalItem({ ...approval, conversationId }))
  }
  for (const question of input.questions ?? []) {
    items.push(normalizeQuestionItem({ ...question, conversationId }))
  }

  return normalizeHistoryPage({
    items,
    nextBefore: input.historyBefore,
    totalItems: input.totalItems,
  })
}

// ── 8. Pure Normalizers: Group Chat ──────────────────────────────────────────────────────────

export interface GroupShellInput {
  readonly id: string
  readonly title?: string | null
  readonly workspaceId?: string | null
  readonly createdAt?: TimestampInput
  readonly updatedAt?: TimestampInput
  readonly lastMessage?: { readonly body?: string | null; readonly createdAt?: TimestampInput } | null
  readonly unreadCount?: number | string | null
  readonly pinned?: boolean
  readonly archived?: boolean
  readonly answering?: ReadonlyArray<{ readonly memberType: string; readonly id: string }> | null
  readonly agentStatus?: { readonly status?: string | null } | null
  readonly stopped?: boolean
  readonly routingError?: { readonly code?: string } | null
  readonly memberCount?: number
  readonly readOnly?: boolean
  readonly canReply?: boolean
}

export function normalizeGroupShell(input: GroupShellInput): MikkaGroupConversationShell {
  const id = groupConversationId(input.id)
  const readOnly = input.readOnly === true || input.canReply === false
  const canReply = !readOnly
  const createdAt = normalizeIsoTimestamp(input.createdAt)
  const updatedAt =
    normalizeIsoTimestamp(input.updatedAt) ??
    normalizeIsoTimestamp(input.lastMessage?.createdAt) ??
    createdAt ??
    EPOCH_ISO

  let status: MikkaConversationStatus
  if (input.answering && input.answering.length > 0) {
    status = 'running'
  } else if (input.agentStatus?.status) {
    status = normalizeConversationStatus(input.agentStatus.status)
  } else if (input.stopped === true) {
    status = 'stopped'
  } else if (input.routingError) {
    status = 'failed'
  } else {
    status = 'idle'
  }

  const unreadCount = normalizeCount(input.unreadCount)

  return {
    kind: 'group',
    id,
    rawId: input.id,
    title: input.title?.trim() || 'Group',
    status,
    readOnly,
    canReply,
    canRetry: false,
    createdAt,
    updatedAt,
    finishedAt: null,
    issueId: null,
    parentThreadId: null,
    preview: input.lastMessage?.body ?? null,
    workspaceId: input.workspaceId ?? null,
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.archived !== undefined ? { archived: input.archived } : {}),
    ...(typeof input.memberCount === 'number' ? { memberCount: input.memberCount } : {}),
  }
}

export interface GroupMemberInput {
  readonly id: string
  readonly name: string
  readonly memberType: 'user' | 'bot' | 'agent'
  readonly avatarUrl?: string | null
  readonly color?: string | null
  readonly shape?: string | null
}

export interface GroupMessageInput {
  readonly id: string
  readonly position: string | number | bigint
  readonly authorType: 'user' | 'bot' | 'agent'
  readonly authorId: string
  readonly body: string
  readonly createdAt: TimestampInput
  readonly replyToId?: string | null
  readonly pending?: boolean
}

export interface GroupExchangeInput {
  readonly type: 'agent_exchange'
  readonly linkId: string
  readonly anchorPosition: string | number | bigint
  readonly count: string | number
  readonly participants?: readonly GroupMemberInput[]
}

export interface GroupHistoryInput {
  readonly messages: readonly GroupMessageInput[]
  readonly exchanges?: readonly GroupExchangeInput[]
  /** Raw `timeline` array from `GET /api/conversations/:id/messages`; `agent_exchange` items are extracted automatically. */
  readonly timeline?: ReadonlyArray<{ readonly type?: string } & Readonly<Record<string, unknown>>>
  readonly members?: readonly GroupMemberInput[]
  readonly viewerId?: string | null
  readonly nextBefore?: RawHistoryCursor
  readonly hasMore?: boolean
  readonly totalItems?: number | null
}

function extractGroupExchanges(input: GroupHistoryInput): GroupExchangeInput[] {
  const out: GroupExchangeInput[] = [...(input.exchanges ?? [])]
  for (const entry of input.timeline ?? []) {
    if (entry.type !== 'agent_exchange') continue
    if (
      typeof entry.linkId === 'string' &&
      (typeof entry.anchorPosition === 'string' ||
        typeof entry.anchorPosition === 'number' ||
        typeof entry.anchorPosition === 'bigint') &&
      (typeof entry.count === 'string' || typeof entry.count === 'number')
    ) {
      out.push({
        type: 'agent_exchange',
        linkId: entry.linkId,
        anchorPosition: entry.anchorPosition,
        count: entry.count,
        participants: Array.isArray(entry.participants)
          ? (entry.participants as GroupMemberInput[])
          : undefined,
      })
    }
  }
  return out
}

function parseBigIntPosition(value: string | number | bigint): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null
  const trimmed = value.trim()
  if (!/^-?[0-9]+$/.test(trimmed)) return null
  return BigInt(trimmed)
}

function compareBigIntPositions(a: string | number | bigint, b: string | number | bigint): number {
  const left = parseBigIntPosition(a)
  const right = parseBigIntPosition(b)
  if (left !== null && right !== null) {
    return left < right ? -1 : left > right ? 1 : 0
  }
  return String(a).localeCompare(String(b))
}

function resolveGroupSpeaker(
  authorType: 'user' | 'bot' | 'agent',
  authorId: string,
  membersByKey: ReadonlyMap<string, GroupMemberInput>,
): MikkaSpeaker {
  const found = membersByKey.get(`${authorType}:${authorId}`)
  const kind: MikkaSpeaker['kind'] = authorType === 'user' ? 'person' : authorType
  const fallbackName = authorType === 'user' ? 'Member' : authorType === 'agent' ? 'Agent' : 'Bot'
  return {
    kind,
    id: authorId,
    name: found?.name.trim() || fallbackName,
    avatarUrl: found?.avatarUrl ?? null,
    color: found?.color ?? null,
    shape: found?.shape ?? null,
  }
}

/**
 * Normalizes a group message page (which backend SQL returns newest-first with stringified `bigint`
 * positions) into canonical oldest-first `MikkaHistoryPage<MikkaProtocolItem>`.
 */
export function normalizeGroupHistoryPage(
  groupId: string,
  input: GroupHistoryInput,
): MikkaHistoryPage<MikkaProtocolItem> {
  const conversationId = groupConversationId(groupId)
  const membersByKey = new Map<string, GroupMemberInput>(
    (input.members ?? []).map((member) => [`${member.memberType}:${member.id}`, member]),
  )

  const sortedMessages = [...input.messages].sort((a, b) =>
    compareBigIntPositions(a.position, b.position),
  )

  const exchanges = extractGroupExchanges(input)
  const exchangesByAnchor = new Map<string, GroupExchangeInput[]>()
  for (const exchange of exchanges) {
    const anchor = String(exchange.anchorPosition)
    const list = exchangesByAnchor.get(anchor)
    if (list) list.push(exchange)
    else exchangesByAnchor.set(anchor, [exchange])
  }

  const emittedExchangeIds = new Set<string>()
  const items: MikkaProtocolItem[] = []

  const pushExchange = (exchange: GroupExchangeInput, fallbackCreatedAt: string) => {
    if (emittedExchangeIds.has(exchange.linkId)) return
    emittedExchangeIds.add(exchange.linkId)
    const names = (exchange.participants ?? []).map((p) => p.name.trim()).filter(Boolean)
    const count = String(exchange.count)
    const label =
      names.length > 0 ? `${names.join(' ↔ ')} (${count})` : `Agent exchange (${count})`
    items.push({
      type: 'status_notice',
      id: `exchange:${exchange.linkId}`,
      conversationId,
      position: String(exchange.anchorPosition),
      createdAt: fallbackCreatedAt,
      noticeKind: 'agent_exchange',
      level: 'info',
      text: label,
      code: 'agent_exchange',
      meta: {
        linkId: exchange.linkId,
        anchorPosition: String(exchange.anchorPosition),
        count,
      },
    })
  }

  for (const msg of sortedMessages) {
    const posStr = String(msg.position)
    const createdAt = normalizeIsoTimestamp(msg.createdAt) ?? EPOCH_ISO
    const createdAtMs = toTimestampMs(createdAt)
    const mine = msg.authorType === 'user' && Boolean(input.viewerId) && msg.authorId === input.viewerId

    items.push({
      type: 'message',
      id: msg.id,
      conversationId,
      position: posStr,
      createdAt,
      startedAtMs: createdAtMs,
      completedAtMs: msg.pending ? null : createdAtMs,
      role: msg.authorType === 'user' ? 'user' : 'assistant',
      text: msg.body,
      mine,
      speaker: resolveGroupSpeaker(msg.authorType, msg.authorId, membersByKey),
      replyToId: msg.replyToId ?? null,
      ...(msg.pending === true ? { pending: true } : {}),
    })

    for (const exchange of exchangesByAnchor.get(posStr) ?? []) {
      pushExchange(exchange, createdAt)
    }
  }

  // Keep unanchored exchanges (delta reads where anchor lives on an earlier page).
  const tailTime = items.at(-1)?.createdAt ?? EPOCH_ISO
  for (const exchange of exchanges) {
    pushExchange(exchange, tailTime)
  }

  return normalizeHistoryPage({
    items,
    nextBefore: input.nextBefore,
    hasMore: input.hasMore,
    totalItems: input.totalItems,
  })
}

// ── 9. Pure Normalizers: Task Thread ─────────────────────────────────────────────────────────

export interface ThreadShellInput {
  readonly id: string
  readonly liveRunId?: string | null
  readonly title?: string | null
  readonly name?: string | null
  readonly status?: string | null
  readonly outcome?: string | null
  readonly stopReason?: string | null
  readonly working?: boolean
  readonly error?: string | null
  readonly createdAt?: TimestampInput
  readonly updatedAt?: TimestampInput
  readonly finishedAt?: TimestampInput
  readonly issueId?: string | null
  readonly parentThreadId?: MikkaConversationId | null
  readonly parentRunId?: string | null
  readonly canReply?: boolean
  readonly readOnly?: boolean
  readonly harness?: string | null
  readonly model?: string | null
  readonly by?: string | null
  readonly dispatchedBy?: string | null
  readonly summary?: string | null
  readonly unread?: boolean
  readonly unreadCount?: number
  readonly pinned?: boolean
  readonly archived?: boolean
}

function resolveParentThreadId(input: {
  readonly parentThreadId?: string | null
  readonly parentRunId?: string | null
  readonly botId?: string | null
}): MikkaConversationId | null {
  if (input.parentThreadId) {
    const parsed = parseConversationId(input.parentThreadId)
    if (parsed) return parsed.id
    if (isValidConversationRawId(input.parentThreadId)) {
      return threadConversationId(input.parentThreadId)
    }
  }
  if (input.parentRunId && isValidConversationRawId(input.parentRunId)) {
    return threadConversationId(input.parentRunId)
  }
  if (input.botId && isValidConversationRawId(input.botId)) {
    return botConversationId(input.botId)
  }
  return null
}

export function normalizeThreadShell(input: ThreadShellInput): MikkaThreadConversationShell {
  const id = threadConversationId(input.id)
  const liveRunId =
    input.liveRunId && isValidConversationRawId(input.liveRunId) ? input.liveRunId : input.id
  const readOnly = input.readOnly === true || input.canReply === false
  const canReply = !readOnly
  const createdAt = normalizeIsoTimestamp(input.createdAt)
  const finishedAt = normalizeIsoTimestamp(input.finishedAt)
  const updatedAt =
    normalizeIsoTimestamp(input.updatedAt) ?? finishedAt ?? createdAt ?? EPOCH_ISO
  const status = normalizeConversationStatus({
    status: input.status,
    outcome: input.outcome,
    stopReason: input.stopReason,
    working: input.working,
    error: input.error,
  })
  const unreadCount =
    input.unreadCount !== undefined
      ? normalizeCount(input.unreadCount)
      : input.unread === true
        ? 1
        : input.unread === false
          ? 0
          : undefined

  return {
    kind: 'thread',
    id,
    rawId: input.id,
    liveRunId,
    title: input.title?.trim() || input.name?.trim() || 'Thread',
    status,
    readOnly,
    canReply,
    canRetry: false,
    createdAt,
    updatedAt,
    finishedAt,
    issueId: input.issueId ?? null,
    parentThreadId: resolveParentThreadId(input),
    preview: input.summary ?? null,
    harness: input.harness ?? null,
    model: input.model ?? null,
    dispatchedBy: input.dispatchedBy ?? input.by ?? null,
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.archived !== undefined ? { archived: input.archived } : {}),
  }
}

export interface ThreadStepInput {
  readonly id: string
  readonly name: string
  readonly detail?: string | null
  readonly failed?: boolean
  readonly kind?: string | null
  readonly status?: string | null
  readonly command?: string | null
  readonly output?: string | null
  readonly outputTruncated?: boolean
  readonly exitCode?: number | null
  readonly target?: string | null
  readonly scope?: string | null
  readonly ms?: number | null
}

export type ThreadRowInput =
  | {
      readonly kind: 'person'
      readonly id: string
      readonly text: string
      readonly author?: string | null
      readonly image?: string | null
      readonly mine?: boolean
      readonly at: TimestampInput
    }
  | {
      readonly kind: 'agent'
      readonly id: string
      readonly text: string
      readonly at: TimestampInput
    }
  | {
      readonly kind: 'steps'
      readonly id: string
      readonly count?: number
      readonly steps: readonly ThreadStepInput[]
      readonly at: TimestampInput
    }
  | {
      readonly kind: 'error'
      readonly id: string
      readonly text: string
      readonly at: TimestampInput
    }
  | {
      readonly kind: 'stages'
      readonly id: string
      readonly stages: ReadonlyArray<{ readonly stage: string; readonly ms: number; readonly ok: boolean }>
      readonly at: TimestampInput
    }
  | {
      readonly kind: 'computer'
      readonly id: string
      readonly botId: string
      readonly runId: string
      readonly task: string
      readonly at: TimestampInput
    }

export interface ThreadHistoryInput {
  readonly items: readonly ThreadRowInput[]
  readonly active?: boolean
  readonly working?: boolean
  readonly subagents?: readonly SubagentShellInput[]
  readonly approvals?: readonly ApprovalItemInput[]
  readonly questions?: readonly QuestionItemInput[]
  readonly nextBefore?: RawHistoryCursor
  readonly hasMore?: boolean
  readonly totalItems?: number | null
}

function normalizeStepStatus(step: ThreadStepInput, runActive: boolean): MikkaToolStatus {
  const raw = step.status?.trim().toLowerCase() ?? ''
  if (raw === 'running') return runActive ? 'running' : 'cancelled'
  if (raw === 'failed' || raw === 'error' || step.failed === true) return 'failed'
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled'
  return 'completed'
}

function projectThreadRows(
  conversationId: MikkaConversationId,
  input: ThreadHistoryInput,
): MikkaHistoryPage<MikkaProtocolItem> {
  const runActive = input.active === true || input.working === true
  const items: MikkaProtocolItem[] = []

  for (const row of input.items) {
    const createdAt = normalizeIsoTimestamp(row.at) ?? EPOCH_ISO
    const createdAtMs = toTimestampMs(createdAt)

    switch (row.kind) {
      case 'person': {
        const mine = row.mine !== false
        const authorName = row.author?.trim() || (mine ? 'You' : 'Member')
        items.push({
          type: 'message',
          id: row.id,
          conversationId,
          createdAt,
          startedAtMs: createdAtMs,
          completedAtMs: createdAtMs,
          role: 'user',
          text: row.text,
          mine,
          ...(mine && !row.author
            ? {}
            : {
                speaker: {
                  kind: 'person',
                  id: row.author?.trim() || row.id,
                  name: authorName,
                  avatarUrl: row.image ?? null,
                },
              }),
        })
        break
      }
      case 'agent': {
        items.push({
          type: 'message',
          id: row.id,
          conversationId,
          createdAt,
          startedAtMs: createdAtMs,
          completedAtMs: createdAtMs,
          role: 'assistant',
          text: row.text,
          mine: false,
        })
        break
      }
      case 'steps': {
        for (const [index, step] of row.steps.entries()) {
          const status = normalizeStepStatus(step, runActive)
          const durationMs =
            typeof step.ms === 'number' && Number.isFinite(step.ms) && step.ms >= 0
              ? Math.round(step.ms)
              : null
          items.push({
            type: 'tool',
            id: `${row.id}:${step.id || index}`,
            conversationId,
            createdAt,
            startedAtMs: createdAtMs,
            completedAtMs:
              status === 'running'
                ? null
                : createdAtMs !== null && durationMs !== null
                  ? createdAtMs + durationMs
                  : createdAtMs,
            callId: step.id || `${row.id}:${index}`,
            name: step.name,
            kind: normalizeToolKind(step.kind),
            status,
            target: step.target ?? null,
            scope: step.scope ?? null,
            detail: step.detail ?? null,
            command: step.command ?? null,
            output: step.output ?? null,
            ...(step.outputTruncated === true ? { outputTruncated: true } : {}),
            exitCode: step.exitCode ?? null,
            durationMs,
          })
        }
        break
      }
      case 'error': {
        items.push({
          type: 'status_notice',
          id: row.id,
          conversationId,
          createdAt,
          startedAtMs: createdAtMs,
          completedAtMs: createdAtMs,
          noticeKind: 'error',
          level: 'error',
          text: row.text,
        })
        break
      }
      case 'stages': {
        const failed = row.stages.some((stage) => !stage.ok)
        const summary = row.stages
          .map((stage) => `${stage.stage} (${Math.round(stage.ms)}ms)`)
          .join(' · ')
        items.push({
          type: 'status_notice',
          id: row.id,
          conversationId,
          createdAt,
          startedAtMs: createdAtMs,
          completedAtMs: createdAtMs,
          noticeKind: 'stage',
          level: failed ? 'error' : 'info',
          text: summary,
          meta: { stages: row.stages },
        })
        break
      }
      case 'computer': {
        items.push({
          type: 'status_notice',
          id: row.id,
          conversationId,
          createdAt,
          startedAtMs: createdAtMs,
          completedAtMs: createdAtMs,
          noticeKind: 'computer',
          level: 'info',
          text: row.task,
          meta: { botId: row.botId, runId: row.runId },
        })
        break
      }
    }
  }

  for (const subagent of input.subagents ?? []) {
    items.push({
      ...normalizeSubagentSummaryItem({
        ...subagent,
        parentThreadId: subagent.parentThreadId ?? conversationId,
      }),
      conversationId,
    })
  }
  for (const approval of input.approvals ?? []) {
    items.push(normalizeApprovalItem({ ...approval, conversationId }))
  }
  for (const question of input.questions ?? []) {
    items.push(normalizeQuestionItem({ ...question, conversationId }))
  }

  return normalizeHistoryPage({
    items,
    nextBefore: input.nextBefore,
    hasMore: input.hasMore,
    totalItems: input.totalItems,
  })
}

export function normalizeThreadHistoryPage(
  runId: string,
  input: ThreadHistoryInput,
): MikkaHistoryPage<MikkaProtocolItem> {
  return projectThreadRows(threadConversationId(runId), input)
}

// ── 10. Pure Normalizers: Read-Only Subagent (Decision 1 / R-10) ─────────────────────────────

export interface SubagentFactsInput {
  readonly profile?: { readonly name: string; readonly icon: string; readonly color: string } | null
  readonly model?: string | null
  readonly brief?: string | null
}

/**
 * Accepts both `lib/subagent-run-read.ts` (`SubagentRun`) and `lib/subagent-runs.ts`
 * (`SubagentRunCard`) plus `RunSource` rows, preserving `finishedAt` and parent lineage.
 */
export interface SubagentShellInput {
  readonly id: string
  readonly latestRunId?: string | null
  readonly issueId?: string | null
  readonly parentThreadId?: MikkaConversationId | null
  readonly parentRunId?: string | null
  readonly botId?: string | null
  readonly title?: string | null
  readonly name?: string | null
  readonly harness?: string | null
  readonly model?: string | null
  readonly agentRole?: string | null
  readonly brief?: string | null
  readonly summary?: string | null
  readonly lastReply?: string | null
  readonly status?: string | null
  readonly outcome?: string | null
  readonly stopReason?: string | null
  readonly createdAt?: TimestampInput
  readonly startedAt?: TimestampInput
  readonly updatedAt?: TimestampInput
  readonly finishedAt?: TimestampInput
  readonly durationMs?: number | null
  readonly profile?: { readonly name?: string; readonly icon: string; readonly color: string } | null
  readonly subagent?: SubagentFactsInput | null
}

function resolveSubagentProfile(
  input: SubagentShellInput,
): { readonly name: string; readonly icon: string; readonly color: string } | null {
  if (input.subagent?.profile) {
    return {
      name: input.subagent.profile.name,
      icon: input.subagent.profile.icon,
      color: input.subagent.profile.color,
    }
  }
  if (input.profile) {
    return {
      name: input.profile.name?.trim() || input.name?.trim() || input.title?.trim() || 'Subagent',
      icon: input.profile.icon,
      color: input.profile.color,
    }
  }
  return null
}

function resolveSubagentName(input: SubagentShellInput): string {
  return (
    input.subagent?.profile?.name?.trim() ||
    input.profile?.name?.trim() ||
    input.name?.trim() ||
    input.title?.trim() ||
    input.harness?.trim() ||
    'Subagent'
  )
}

/**
 * Normalizes any subagent run row into a strictly read-only `MikkaSubagentConversationShell`.
 * Enforces Decision 1 / R-10 (`readOnly: true`, `canReply: false`, `canRetry: false`) regardless
 * of caller input, and preserves `finishedAt` for frozen elapsed-duration rendering (Evidence A).
 */
export function normalizeSubagentShell(input: SubagentShellInput): MikkaSubagentConversationShell {
  const id = subagentConversationId(input.id)
  const latestRunId =
    input.latestRunId && isValidConversationRawId(input.latestRunId) ? input.latestRunId : input.id
  const createdAt = normalizeIsoTimestamp(input.createdAt ?? input.startedAt)
  const finishedAt = normalizeIsoTimestamp(input.finishedAt)
  const updatedAt =
    finishedAt ?? normalizeIsoTimestamp(input.updatedAt) ?? createdAt ?? EPOCH_ISO
  const status = normalizeSubagentStatus({
    status: input.status,
    outcome: input.outcome,
    stopReason: input.stopReason,
    finishedAt,
  })
  const profile = resolveSubagentProfile(input)
  const brief = input.subagent?.brief?.trim() || input.brief?.trim() || null
  const model = input.subagent?.model?.trim() || input.model?.trim() || null
  const title = input.title?.trim() || resolveSubagentName(input)

  return {
    kind: 'subagent',
    id,
    rawId: input.id,
    latestRunId,
    title,
    status,
    readOnly: true,
    canReply: false,
    canRetry: false,
    createdAt,
    updatedAt,
    finishedAt,
    issueId: input.issueId ?? null,
    parentThreadId: resolveParentThreadId(input),
    preview: input.summary?.trim() || input.lastReply?.trim() || brief,
    harness: input.harness ?? null,
    model,
    agentRole: input.agentRole ?? null,
    brief,
    profile,
  }
}

/**
 * Projects a subagent run row into a `MikkaSubagentSummaryItem` for rendering inside its parent
 * thread transcript (carrying frozen `finishedAt`, computed `durationMs`, and read-only target).
 */
export function normalizeSubagentSummaryItem(
  input: SubagentShellInput,
): MikkaSubagentSummaryItem {
  const subagentId = subagentConversationId(input.id)
  const latestRunId =
    input.latestRunId && isValidConversationRawId(input.latestRunId) ? input.latestRunId : input.id
  const startedAt = normalizeIsoTimestamp(input.startedAt ?? input.createdAt) ?? EPOCH_ISO
  const finishedAt = normalizeIsoTimestamp(input.finishedAt)
  const startedAtMs = toTimestampMs(startedAt)
  const completedAtMs = toTimestampMs(finishedAt)
  const explicitDuration =
    typeof input.durationMs === 'number' &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0
      ? Math.round(input.durationMs)
      : null
  const durationMs = explicitDuration ?? computeDurationMs(startedAt, finishedAt)
  const status = normalizeSubagentStatus({
    status: input.status,
    outcome: input.outcome,
    stopReason: input.stopReason,
    finishedAt,
  })
  const profile = resolveSubagentProfile(input)

  return {
    type: 'subagent_summary',
    id: `subagent:${input.id}`,
    subagentId,
    rawRunId: input.id,
    latestRunId,
    parentThreadId: resolveParentThreadId(input),
    name: resolveSubagentName(input),
    status,
    readOnly: true,
    canReply: false,
    harness: input.harness ?? null,
    model: input.subagent?.model?.trim() || input.model?.trim() || null,
    agentRole: input.agentRole ?? null,
    brief: input.subagent?.brief?.trim() || input.brief?.trim() || null,
    summary: input.summary?.trim() || input.lastReply?.trim() || null,
    profile: profile ? { icon: profile.icon, color: profile.color } : null,
    createdAt: startedAt,
    startedAt,
    finishedAt,
    startedAtMs,
    completedAtMs,
    durationMs,
  }
}

/** Projects a subagent's own read-only transcript using the shared thread item pipeline. */
export function normalizeSubagentHistoryPage(
  runId: string,
  input: ThreadHistoryInput,
): MikkaHistoryPage<MikkaProtocolItem> {
  return projectThreadRows(subagentConversationId(runId), input)
}

// ── 11. Polymorphic Shell Normalizer ─────────────────────────────────────────────────────────

export type PolymorphicShellInput =
  | ({ readonly kind: 'bot' } & BotShellInput)
  | ({ readonly kind: 'group' } & GroupShellInput)
  | ({ readonly kind: 'thread' } & ThreadShellInput)
  | ({ readonly kind: 'subagent' } & SubagentShellInput)

export function normalizeConversationShell(
  input: { readonly kind: 'bot' } & BotShellInput,
): MikkaBotConversationShell
export function normalizeConversationShell(
  input: { readonly kind: 'group' } & GroupShellInput,
): MikkaGroupConversationShell
export function normalizeConversationShell(
  input: { readonly kind: 'thread' } & ThreadShellInput,
): MikkaThreadConversationShell
export function normalizeConversationShell(
  input: { readonly kind: 'subagent' } & SubagentShellInput,
): MikkaSubagentConversationShell
export function normalizeConversationShell(input: PolymorphicShellInput): MikkaConversationShell
export function normalizeConversationShell(input: PolymorphicShellInput): MikkaConversationShell {
  switch (input.kind) {
    case 'bot':
      return normalizeBotShell(input)
    case 'group':
      return normalizeGroupShell(input)
    case 'thread':
      return normalizeThreadShell(input)
    case 'subagent':
      return normalizeSubagentShell(input)
  }
}
