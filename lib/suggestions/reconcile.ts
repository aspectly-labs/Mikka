import 'server-only'
import { and, eq, gte, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { suggestions, suggestionTriggerChecks } from '@/lib/db/schema'
import { getComposio, runComposioAction } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { redeliverFailedGitHubWebhooks, type RedeliveryResult } from './github-redelivery'
import { gmailNotification, notionSearchNotification, type ExternalNotification } from './notification'
import { ensureComposioTriggers } from './sources'
import { TRIGGER_CHECK_INTERVAL_MS } from './triggers'
import { ingestNotifications } from './store'
import { clearComposioNeedsReconnect, markComposioNeedsReconnect } from '@/lib/composio-account-store'

// The hourly backfill behind the webhooks (app/api/cron/suggestions-reconcile).
// It reads what each source holds now and ingests it like a webhook delivery;
// ingestNotifications skips anything already stored under the same external
// id, so only what a lost delivery missed is judged and added. GitHub is not
// re-read: Mikka's GitHub App asks GitHub to send its failed webhook
// deliveries again (./github-redelivery).

/** How far back the backfill looks. Longer than its interval, so one missed run is still covered. */
export const RECONCILE_WINDOW_MS = 26 * 60 * 60 * 1000
/** A person is re-reconciled well inside the window, so a sweep running late still reaches edits its previous pass already missed. */
const RECONCILE_DUE_MS = RECONCILE_WINDOW_MS - 2 * 60 * 60 * 1000
/** Notion pages per sweep are capped in case a workspace accumulates edits faster than the backfill can page. */
const NOTION_PAGE_LIMIT = 3
// Slack is left out: it is moving off Composio to Mikka's own Slack app.
const COMPOSIO_TOOLKITS = ['gmail', 'notion'] as const
const PEOPLE_CONCURRENCY = 4
/**
 * At most this many people are read per run, least recently checked first; the rest are next
 * run's. It bounds the sweep's read and its work, so one run never grows with the user count.
 */
export const PEOPLE_PER_RUN = 100

/** A provider read that failed, with the connected account it ran through when it got that far. */
class ProviderReadError extends Error {
  constructor(message: string, readonly accountId?: string) { super(message) }
}

type Json = Record<string, unknown>
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : []

/** The same mail the Gmail trigger delivers; the Decisions API judges every message, Gmail's categories are only evidence. */
async function recentGmail(userId: string, readThrough: (accountId: string) => void): Promise<ExternalNotification[]> {
  const result = await runComposioAction(userId, 'fetch_recent_gmail', { query: 'in:inbox newer_than:2d', max_results: 50 })
  if ('error' in result) throw new ProviderReadError(result.error, result.accountId)
  readThrough(result.accountId)
  return list(result.data.messages).flatMap(message => ((notification => notification ? { ...notification, connectedAccountId: result.accountId } : [])(gmailNotification(userId, message))))
}

/**
 * Pages edited in the window. A page already on file under any edit time is
 * skipped: the trigger's edit time may be written differently from search's,
 * and a duplicate would show twice.
 */
async function recentNotion(userId: string, since: Date, readThrough: (accountId: string) => void): Promise<{ notifications: ExternalNotification[]; partialError?: ProviderReadError }> {
  const edited: Json[] = []
  let partialError: ProviderReadError | undefined
  let cursor: string | undefined
  for (let page = 0; page < NOTION_PAGE_LIMIT; page++) {
    const result = await runComposioAction(userId, 'list_recent_notion_pages', { page_size: 100, start_cursor: cursor })
    if ('error' in result) {
      if (!edited.length) throw new ProviderReadError(result.error, result.accountId)
      // A later page failed: keep what the earlier ones fetched, but report it — the pass is
      // not complete, so the marker stays due and the tail retries before the window ages out.
      partialError = new ProviderReadError(result.error, result.accountId)
      break
    }
    readThrough(result.accountId)
    const batch = list(result.data.results)
    edited.push(...batch)
    const data = record(result.data)
    // Sorted newest first: once a page's oldest item is outside the window, every later page is too.
    const oldest = Date.parse(String(batch[batch.length - 1]?.last_edited_time ?? ''))
    if (data.has_more !== true || typeof data.next_cursor !== 'string' || !data.next_cursor
      || (Number.isFinite(oldest) && oldest < since.getTime())) break
    cursor = data.next_cursor
  }
  const pages = edited.flatMap(page => notionSearchNotification(userId, page) ?? []).filter(page => page.occurredAt >= since)
  if (!pages.length) return { notifications: [], partialError }
  const known = await db.select({ externalId: suggestions.externalId }).from(suggestions)
    .where(and(eq(suggestions.userId, userId), eq(suggestions.source, 'notion'), gte(suggestions.createdAt, new Date(since.getTime() - RECONCILE_WINDOW_MS))))
  const pageId = (externalId: string) => externalId.split(':')[0]
  const knownPages = new Set(known.map(row => pageId(row.externalId)))
  return { notifications: pages.filter(page => !knownPages.has(pageId(page.externalId))), partialError }
}

/**
 * Whether a provider refused the person's own authorization (a revoked or
 * expired token), as opposed to Mikka or the provider failing. Only the person
 * can fix that by reconnecting the app, so the run skips them and carries on.
 */
export function needsReconnect(message: string): boolean {
  if (/\b(?:token_invalid|invalid_token|invalid_grant|token_expired|unauthorized|unauthenticated)\b/i.test(message)) return true
  if (/"status"\s*:\s*401\b/.test(message) || /\b401\b.*\b(?:unauthori[sz]ed|token)\b/i.test(message)) return true
  return false
}

export interface ReconcileResult {
  people: number; read: Record<string, number>; failed: Record<string, number>
  /** Connections whose provider refused the person's authorization: theirs to reconnect, not a failed run. */
  reconnect: Record<string, number>
  deferred: number; linear: { deliveries: number; notifications: number }; github: RedeliveryResult | null
  /**
   * People whose pass was still running at the deadline: the run stopped waiting for them (a stalled
   * provider call or database connection would otherwise hold the response past the route's limit).
   * Their writes are idempotent and they stay due, so the next run takes them again. Counted in `deferred` too.
   */
  overran?: number
}

/** Returns how many provider reads failed; the caller only stamps a clean pass as reconciled. */
async function reconcilePerson(userId: string, toolkits: readonly string[], since: Date, result: ReconcileResult): Promise<number> {
  let failedReads = 0
  let readThroughAccount: string | null = null
  const readThrough = (accountId: string) => { readThroughAccount = accountId }
  const readers: Record<string, () => Promise<{ notifications: ExternalNotification[]; partialError?: ProviderReadError }>> = {
    gmail: async () => ({ notifications: await recentGmail(userId, readThrough) }),
    notion: () => recentNotion(userId, since, readThrough),
  }
  for (const toolkit of toolkits) {
    readThroughAccount = null
    try {
      const { notifications, partialError } = await readers[toolkit]()
      // It works again (or was reconnected in place): it no longer needs reconnection.
      if (readThroughAccount) await clearComposioNeedsReconnect(userId, readThroughAccount)
        .catch((error: unknown) => console.error('Could not clear a reconnect mark', error instanceof Error ? error.name : 'unknown'))
      await ingestNotifications(notifications)
      result.read[toolkit] = (result.read[toolkit] ?? 0) + notifications.length
      // The fetched pages are in; the failed tail still counts the pass as failed.
      if (partialError) throw partialError
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (needsReconnect(message)) {
        // The provider's answer is not logged: it is about the person's credentials.
        result.reconnect[toolkit] = (result.reconnect[toolkit] ?? 0) + 1
        console.warn(`Suggestions backfill skipped ${toolkit}: the connection needs reconnecting`)
        // The connected-apps list then offers the person a reconnect for that account.
        const accountId = error instanceof ProviderReadError ? error.accountId : undefined
        if (accountId) await markComposioNeedsReconnect(userId, toolkit, accountId)
          .catch((markError: unknown) => console.error('Could not mark a connection for reconnecting', markError instanceof Error ? markError.name : 'unknown'))
        continue
      }
      result.failed[toolkit] = (result.failed[toolkit] ?? 0) + 1
      failedReads++
      console.error(`Suggestions backfill could not read ${toolkit}`, error instanceof Error ? error.name : 'unknown')
    }
  }
  return failedReads
}

/**
 * Backfills the window for everyone who uses the suggestions list (has opened
 * it or connected an app through Composio). Stops starting new people after
 * `deadline`; they are covered by the next run while still in the window.
 */
export async function reconcileSuggestions({ now = new Date(), deadline = Infinity }: { now?: Date; deadline?: number } = {}): Promise<ReconcileResult> {
  const since = new Date(now.getTime() - RECONCILE_WINDOW_MS)
  const result: ReconcileResult = { people: 0, read: {}, failed: {}, reconnect: {}, deferred: 0, linear: { deliveries: 0, notifications: 0 }, github: null }
  try { result.github = await redeliverFailedGitHubWebhooks({ now, deadline }) }
  catch (error) {
    result.failed.github = 1
    console.error('Suggestions backfill could not redeliver GitHub webhooks', error instanceof Error ? error.name : 'unknown')
  }
  if (Date.now() >= deadline) return result
  const composio = getComposio()
  if (!composio) return result
  // Least recently checked first, so a run cut short by the deadline moves on to others next time.
  // Per-item due (#2820): a person belongs in the sweep when the suggestions pipeline hasn't touched them
  // within the trigger interval (their pushes may be stale) or nobody reconciled them inside the backfill
  // window — not because the hour fired. Least recently checked first, so a deadline-cut run resumes at the front.
  const people = (await db.select({ userId: suggestionTriggerChecks.userId }).from(suggestionTriggerChecks)
    .where(or(lt(suggestionTriggerChecks.checkedAt, new Date(now.getTime() - TRIGGER_CHECK_INTERVAL_MS)),
      or(isNull(suggestionTriggerChecks.reconciledAt), lt(suggestionTriggerChecks.reconciledAt, new Date(now.getTime() - RECONCILE_DUE_MS)))))
    .orderBy(suggestionTriggerChecks.checkedAt).limit(PEOPLE_PER_RUN)).map(row => row.userId)
  for (let index = 0; index < people.length; index += PEOPLE_CONCURRENCY) {
    if (Date.now() > deadline) { result.deferred = people.length - index; break }
    const batch = people.slice(index, index + PEOPLE_CONCURRENCY)
    let settled = 0
    const passes = Promise.all(batch.map(async userId => {
      try {
        const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [...COMPOSIO_TOOLKITS], statuses: ['ACTIVE'], cursor }))
        const toolkits = [...new Set(accounts.filter(account => account.status === 'ACTIVE' && !account.isDisabled).map(account => account.toolkit.slug.toLowerCase()))]
          .filter(toolkit => (COMPOSIO_TOOLKITS as readonly string[]).includes(toolkit))
        result.people++
        // A lost subscription is the likeliest reason deliveries stopped; re-create it (at most hourly).
        // It runs for everyone swept, so a person with nothing connected still advances their check.
        await ensureComposioTriggers(userId).catch((error: unknown) => console.error('Composio trigger check failed', error instanceof Error ? error.name : 'unknown'))
        const failedReads = toolkits.length ? await reconcilePerson(userId, toolkits, since, result) : 0
        // A pass whose reads failed stays due whatever the other clock says — clearing the marker keeps it
        // in the next sweep, so the retry lands before the window ages the missed edits out.
        await db.update(suggestionTriggerChecks).set({ reconciledAt: failedReads ? null : now }).where(eq(suggestionTriggerChecks.userId, userId))
      } catch (error) {
        result.failed.composio = (result.failed.composio ?? 0) + 1
        console.error('Suggestions backfill could not list connected apps', error instanceof Error ? error.name : 'unknown')
      } finally { settled++ }
    }))
    // The deadline bounds the run, not only when the next batch starts: a pass stuck on a call
    // that never answers is left behind (and taken again next run) instead of holding the response.
    if (!await beforeDeadline(passes, deadline)) {
      result.overran = batch.length - settled
      result.deferred = people.length - index - settled
      console.warn(`Suggestions backfill stopped waiting at its deadline: ${result.overran} passes still running`)
      break
    }
  }
  return result
}

/** Whether `work` settles before `deadline`; it is never cancelled, only no longer waited for. */
async function beforeDeadline(work: Promise<unknown>, deadline: number): Promise<boolean> {
  if (!Number.isFinite(deadline)) { await work; return true }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false) })
  try { return await Promise.race([work.then(() => true as const), late]) }
  finally { clearTimeout(timer) }
}
