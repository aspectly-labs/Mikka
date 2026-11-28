import type { ApprovalActionName } from '@/lib/composio-actions'
import type { PendingActionStatus } from '@/lib/db/schema'

/** The shape `/api/pending-actions` used to list. Nothing waits for approval
 * any more (ADR 2026-11-27-1615); the official UI still imports the type until
 * its follow-up removes the card, and the list is always empty. */
export interface PendingActionView {
  id: string
  action: ApprovalActionName | 'browser_operation' | 'app_tool_call'
  input: Record<string, unknown>
  /** For a calendar change: the event as it is now. */
  context: { summary?: string; start?: string; end?: string } | null
  status: PendingActionStatus
  createdAt: string
}

/** Kept for the official UI's cache helper (lib/live/pending-action-cache.ts) until its follow-up. */
export const PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** What to keep from a successful run: ids and the link, not the whole response. */
export function actionOutcome(data: Record<string, unknown> | null | undefined): Record<string, string> {
  const outcome: Record<string, string> = {}
  for (const source of [data, record(data?.response_data)]) {
    for (const key of ['id', 'threadId', 'htmlLink'] as const) {
      const value = source?.[key]
      if (typeof value === 'string' && !outcome[key]) outcome[key] = value
    }
  }
  return outcome
}
