import { createHash } from 'node:crypto'
import { credentialMasker } from '@/lib/secrets/mask'

/**
 * Remembered approvals (decision 2026-11-27-1500-remembered-approvals): the
 * person's 「始终同意」 on one card, as Claude Code's "Yes, and don't ask again"
 * and Codex's approve-for-session / exec-policy amendment.
 *
 * A rule is never written from client input. The server derives it from the
 * stored card, and it covers only what that card showed: the same action, on
 * the same connected account, to the same target class (the same recipients,
 * attendees, event, channel, page, or app tool). Arguments the card showed as
 * data (a message body, a subject) may differ, as a Claude Code Bash prefix or
 * WebFetch domain rule lets the rest of the command differ. Anything outside
 * that, or any action this file does not name, is never remembered.
 *
 * A rule only turns the review's `ask` into `allow`. A deny, a workspace app
 * block or a failed account check still stops the call (deny > ask > allow).
 */
export type ApprovalRuleMatch =
  | { action: 'send_email'; account: string; recipients: string[] }
  | { action: 'create_calendar_event'; account: string; attendees: string[] }
  | { action: 'update_calendar_event'; account: string; eventId: string; attendees: string[] | null }
  | { action: 'app_tool_call'; toolkit: string; tool: string; account: string | null; target: Record<string, unknown> }
  | { action: 'append_notion_paragraph' | 'send_slack_message'; provider: string; account: string; target: string }

/**
 * Never remembered, whatever the card: the product treats these as high risk.
 * A browser action acts on an arbitrary site (decision 2026-11-01-1430); a
 * credential fill uses a saved login; cancelling an event deletes it and
 * notifies its guests. Codex keeps a similar list of prefixes it never offers
 * to remember (`BANNED_PREFIX_SUGGESTIONS`).
 */
export const NEVER_REMEMBERED: ReadonlySet<string> = new Set(['browser_operation', 'credential_operation', 'cancel_calendar_event'])

// An app tool whose slug names an irreversible or permission-changing effect.
// Only an extra layer: an app tool is rememberable only when it is on
// REMEMBERABLE_APP_TOOLS below, whatever its name.
const DESTRUCTIVE_TOOL = /(?:^|_)(?:DELETE|REMOVE|TRASH|DESTROY|PURGE|ERASE|WIPE|CLEAR|ARCHIVE|REVOKE|TRANSFER|PAY|PAYMENT|PAYOUT|CHARGE|REFUND|INVITE|SHARE|SHARING|PERMISSION|PERMISSIONS|ROLE|ROLES|ADMIN|COLLABORATOR|VISIBILITY|SECRET|FILTER|REFERENCE|WORKFLOW|DISPATCH|MERGE|PUBLISH|DEPLOY|DEPLOYMENT|CANCEL|BAN|KICK|BLOCK|SUSPEND|DISABLE|RESET|OVERWRITE|REPLACE|BULK|BATCH|EXECUTE|EXEC|RUN|SQL)(?:_|$)/

/** True when an app tool must never be remembered: by its slug, or by its provider's own destructive tag. */
export function destructiveAppTool(slug: string, tags?: readonly string[]): boolean {
  return DESTRUCTIVE_TOOL.test(slug.toUpperCase()) || Boolean(tags?.includes('destructiveHint'))
}

/**
 * The only app tools a person can say 「始终同意」 to. Each names its target
 * arguments, which are part of the rule exactly (as a Codex exec-policy rule
 * is an exact command prefix), and its data arguments, which may differ. A call
 * with any other argument is never remembered and never matched: the card
 * would show an effect the rule did not name. Every other tool always asks.
 */
export const REMEMBERABLE_APP_TOOLS: Readonly<Record<string, { toolkit: string; target: readonly string[]; data: readonly string[] }>> = {
  // Mail from the person's account to exactly these recipients (GMAIL_SEND_EMAIL's own arguments, lib/composio-actions.ts).
  GMAIL_SEND_EMAIL: { toolkit: 'gmail', target: ['recipient_email', 'extra_recipients', 'cc', 'bcc', 'user_id'], data: ['subject', 'body', 'is_html'] },
  // A message to exactly this channel (and thread, when given).
  SLACK_SEND_MESSAGE: { toolkit: 'slack', target: ['channel', 'thread_ts'], data: ['text', 'markdown_text'] },
}

function targetValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.trim().length && value.length <= 1024 ? value.trim().toLowerCase() : undefined
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) {
    if (value.length > 50 || !value.every(item => typeof item === 'string' && item.trim())) return undefined
    return [...new Set(value.map(item => (item as string).trim().toLowerCase()))].sort()
  }
  return undefined
}

/** The exact target of one allow-listed app tool call, or null when the call can never be remembered. */
export function appToolTarget(toolkit: string, tool: string, args: unknown): Record<string, unknown> | null {
  const entry = Object.hasOwn(REMEMBERABLE_APP_TOOLS, tool) ? REMEMBERABLE_APP_TOOLS[tool] : undefined
  const input = record(args)
  if (!entry || entry.toolkit !== toolkit || !input || destructiveAppTool(tool)) return null
  const known = new Set([...entry.target, ...entry.data])
  if (Object.keys(input).some(key => !known.has(key))) return null
  for (const key of entry.data) if (input[key] !== undefined && !['string', 'boolean'].includes(typeof input[key])) return null
  const target: Record<string, unknown> = {}
  for (const key of entry.target) {
    const value = targetValue(input[key])
    if (value === undefined) return null
    target[key] = value
  }
  return Object.values(target).some(value => value !== null) ? target : null
}

const MAX_SET = 50
function addresses(...lists: unknown[]): string[] | null {
  const all: string[] = []
  for (const list of lists) {
    if (list === undefined || list === null) continue
    if (!Array.isArray(list)) return null
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) return null
      all.push(item.trim().toLowerCase())
    }
  }
  const set = [...new Set(all)].sort()
  return set.length <= MAX_SET ? set : null
}
const text = (value: unknown, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** The rule one pending card (lib/pending-actions.ts) would remember, or null when it is never remembered. */
export function pendingActionRuleMatch(row: { action: string; input: unknown; connectedAccountId: string | null }): ApprovalRuleMatch | null {
  if (NEVER_REMEMBERED.has(row.action)) return null
  const input = record(row.input)
  if (!input) return null
  if (row.action === 'app_tool_call') {
    const toolkit = text(input.toolkit, 64), tool = text(input.tool, 128)
    // The same ownership test the call path uses (lib/app-tools.ts belongsTo).
    if (!toolkit || !tool || !/^[a-z][a-z0-9_]{0,63}$/.test(toolkit) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(tool) || !tool.startsWith(`${toolkit.toUpperCase()}_`)) return null
    const target = appToolTarget(toolkit, tool, input.arguments)
    return target ? { action: 'app_tool_call', toolkit, tool, account: row.connectedAccountId ?? null, target } : null
  }
  // Mail and calendar writes run in one connected account; without one there is nothing to bind.
  const account = text(row.connectedAccountId, 256)
  if (!account) return null
  if (row.action === 'send_email') {
    const recipients = addresses(input.to, input.cc, input.bcc)
    return recipients?.length ? { action: 'send_email', account, recipients } : null
  }
  if (row.action === 'create_calendar_event') {
    const attendees = addresses(input.attendees)
    return attendees ? { action: 'create_calendar_event', account, attendees } : null
  }
  if (row.action === 'update_calendar_event') {
    const eventId = text(input.event_id)
    const attendees = input.attendees === undefined ? null : addresses(input.attendees)
    if (!eventId || input.attendees !== undefined && !attendees) return null
    return { action: 'update_calendar_event', account, eventId, attendees }
  }
  return null
}

/**
 * The rule one approved write (lib/operations/approved-writes.ts) would
 * remember. `target` is the ledger's own target key (`writeTarget`): the Slack
 * channel or the Notion page, never the message text.
 */
export function approvedWriteRuleMatch(write: { action: string; provider: string; accountId: string; target: string }): ApprovalRuleMatch | null {
  if (NEVER_REMEMBERED.has(write.action)) return null
  if (write.action !== 'append_notion_paragraph' && write.action !== 'send_slack_message') return null
  const provider = text(write.provider, 64), account = text(write.accountId, 256), target = text(write.target, 200)
  if (!provider || !account || !target?.startsWith(`${write.action}:`)) return null
  return { action: write.action, provider, account, target }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}

/** The only value a check compares: sha256 of the match's canonical JSON. */
export function approvalRuleKey(match: ApprovalRuleMatch): string {
  return createHash('sha256').update(JSON.stringify(['approval-rule-v1', canonical(match)])).digest('hex')
}

/** The Bot a rule is scoped to: only a card a Bot proposed can be remembered (older rows have none). */
export function ruleBotId(botId: string | null | undefined): string | null {
  return typeof botId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(botId) ? botId.toLowerCase() : null
}

/** The person's note on a decline (Codex `Denied { rejection }`, Claude Code's "tell Claude what to do differently"). */
export const MAX_DECISION_NOTE = 2000
export function decisionNote(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // A pasted token never reaches the event store or the model's prompt.
  const masked = credentialMasker(value.trim())
  return masked ? masked.slice(0, MAX_DECISION_NOTE) : null
}
