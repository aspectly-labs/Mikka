import { createHash } from 'node:crypto'

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
  | { action: 'app_tool_call'; toolkit: string; tool: string; account: string | null }
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
// The card shows one call; a rule would cover every future call of that tool.
const DESTRUCTIVE_TOOL = /(?:^|_)(?:DELETE|REMOVE|TRASH|DESTROY|PURGE|ERASE|WIPE|ARCHIVE|REVOKE|TRANSFER|PAY|PAYMENT|PAYOUT|CHARGE|REFUND|INVITE|SHARE|PERMISSION|PERMISSIONS|ROLE|ROLES|ADMIN|MERGE|PUBLISH|DEPLOY|CANCEL|BAN|KICK|BLOCK|SUSPEND|DISABLE|RESET|OVERWRITE|REPLACE|BULK|BATCH|EXECUTE|EXEC|RUN|SQL|QUERY_WRITE)(?:_|$)/

/** True when an app tool must never be remembered: by its slug, or by its provider's own destructive tag. */
export function destructiveAppTool(slug: string, tags?: readonly string[]): boolean {
  return DESTRUCTIVE_TOOL.test(slug.toUpperCase()) || Boolean(tags?.includes('destructiveHint'))
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
    if (destructiveAppTool(tool)) return null
    return { action: 'app_tool_call', toolkit, tool, account: row.connectedAccountId ?? null }
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
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_DECISION_NOTE) : null
}
