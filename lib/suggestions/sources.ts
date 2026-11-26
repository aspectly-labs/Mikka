import 'server-only'
import { lt } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { suggestionTriggerChecks } from '@/lib/db/schema'
import { getComposio, runComposioAction } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { githubCandidateIds, githubNotification, gmailNotification, type ExternalNotification } from './notification'
import { disabledSuggestionSources } from './source-settings'
import { ingestNotifications, recordTimeZone, writeFirstBriefing } from './store'
import { manualTimeZone } from './time-zone'
import { missingTriggers, TRIGGER_CHECK_INTERVAL_MS, TRIGGER_PATTERNS, triggerSlugs } from './triggers'

// Where notifications come from. Linear and GitHub webhooks carry full
// payloads; Gmail, Slack and Notion arrive as Composio trigger events, which Composio
// polls for us. Right after the person connects an app, its current data is
// read once so the first briefing has something in it.

/** Notifications for every Mikka person a GitHub event is about, matched by their GitHub sign-in. */
export async function githubWebhookNotifications(event: string, payload: Record<string, unknown>): Promise<ExternalNotification[]> {
  const ids = githubCandidateIds(event, payload)
  if (!ids.length) return []
  const result = await pool.query<{ userId: string; accountId: string; cloud_subject: string | null; cloud_workspace_id: string | null }>(`select "userId", "accountId", NULL::text AS cloud_subject, NULL::uuid AS cloud_workspace_id from account where "providerId" = $1 and "accountId" = any($2)
    union select "userId", "githubAccountId",NULL::text,NULL::uuid from github_connections where "githubAccountId"=any($2)
    union select i.user_id,i.github_account_id,i.cloud_subject,i.cloud_workspace_id from cloud_github_installations i
      join cloud_service_bindings b on b.owner='user:'||i.user_id and b.revoked=false and 'github'=any(b.scopes)
      join cloud_service_registration r on r.server_id=b.server_id
      where i.github_account_id=any($2)`, ['github', ids])
  const rows = result.rows.filter(row => !row.cloud_subject)
  const cloud = result.rows.filter(row => row.cloud_subject)
  if (cloud.length) {
    const { cloudClient } = await import('@/lib/cloud-services/runtime')
    const { CloudServiceError } = await import('@/lib/cloud-services/errors')
    for (const candidate of cloud) {
      try {
        const { token } = await cloudClient.access(candidate.userId, 'github')
        if (token.subject === candidate.cloud_subject && token.workspaceId === candidate.cloud_workspace_id) rows.push(candidate)
      } catch (error) { if (!(error instanceof CloudServiceError)) throw error }
    }
  }
  const unique = [...new Map(rows.map(row => [`${row.userId}:${row.accountId}`, row])).values()]
  return unique.flatMap(row => githubNotification({ userId: row.userId, githubId: row.accountId }, event, payload) ?? [])
}

/**
 * Makes sure each of the person's active Gmail, Slack and Notion accounts has
 * its Composio triggers, creating only the missing ones, so it is safe to run
 * again. Unless `force`, it runs at most once per TRIGGER_CHECK_INTERVAL_MS.
 * Returns the toolkits the person has connected.
 */
export async function ensureComposioTriggers(userId: string, { force = false } = {}): Promise<string[]> {
  const composio = getComposio()
  if (!composio) return []
  const now = new Date()
  if (!force) {
    // Claim the check first, so concurrent reads do not all call Composio.
    const claimed = await db.insert(suggestionTriggerChecks).values({ userId, checkedAt: now })
      .onConflictDoUpdate({ target: suggestionTriggerChecks.userId, set: { checkedAt: now }, setWhere: lt(suggestionTriggerChecks.checkedAt, new Date(now.getTime() - TRIGGER_CHECK_INTERVAL_MS)) })
      .returning({ userId: suggestionTriggerChecks.userId })
    if (!claimed.length) return []
  } else {
    await db.insert(suggestionTriggerChecks).values({ userId, checkedAt: now }).onConflictDoUpdate({ target: suggestionTriggerChecks.userId, set: { checkedAt: now } })
  }
  const accounts = await activeComposioAccounts(composio, userId)
  const toolkits = [...new Set(accounts.map(account => account.toolkit.slug))]
  const watched = toolkits.filter(toolkit => TRIGGER_PATTERNS[toolkit])
  if (!watched.length) return toolkits
  const [catalog, active] = await Promise.all([
    listComposioPages(cursor => composio.triggers.listTypes({ toolkits: watched, cursor })),
    listComposioPages(cursor => composio.triggers.listActive({ connectedAccountIds: accounts.map(account => account.id), cursor })),
  ])
  const wanted = accounts.flatMap(account => triggerSlugs(account.toolkit.slug, catalog.filter(type => type.toolkit.slug.toLowerCase() === account.toolkit.slug.toLowerCase())).map(slug => ({ connectedAccountId: account.id, slug })))
  for (const { connectedAccountId, slug } of missingTriggers(wanted, active)) {
    try {
      await composio.triggers.create(userId, slug, { connectedAccountId })
    } catch (error) {
      console.error('Composio trigger subscription failed', { trigger: slug, error: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return toolkits
}

async function activeComposioAccounts(composio: NonNullable<ReturnType<typeof getComposio>>, userId: string) {
  return (await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], statuses: ['ACTIVE'], cursor })))
    .filter(account => account.status === 'ACTIVE' && !account.isDisabled)
}

/** The Composio toolkits the person has an active account for; empty without Composio. */
export async function connectedComposioApps(userId: string): Promise<string[]> {
  const composio = getComposio()
  if (!composio) return []
  return [...new Set((await activeComposioAccounts(composio, userId)).map(account => account.toolkit.slug.toLowerCase()))]
}

/** Inbox mail from the last two days; the Decisions API judges which of it matters. */
async function currentGmail(userId: string): Promise<ExternalNotification[]> {
  const result = await runComposioAction(userId, 'fetch_recent_gmail', { query: 'in:inbox newer_than:2d', max_results: 15 })
  if ('error' in result) return []
  const messages = (result.data as { messages?: unknown }).messages
  return Array.isArray(messages) ? messages.flatMap(message => ((notification => notification ? { ...notification, connectedAccountId: result.accountId } : [])(gmailNotification(userId, message as Record<string, unknown>)))) : []
}

/**
 * Runs right after the person connects an app: subscribes its triggers, reads
 * what is there now, rates it like any webhook (without handing it to the
 * Coordinator one by one), and writes the first briefing, which the
 * Coordinator then delivers in its chat. Never throws; a source that fails just adds nothing.
 */
export async function bootstrapSuggestions(userId: string, app: 'composio' | 'linear', timeZone: string | null) {
  if (app === 'linear') return
  const read = async <T,>(label: string, load: () => Promise<T[]>): Promise<T[]> => {
    try { return await load() } catch (error) {
      console.error(`First briefing could not read ${label}`, error instanceof Error ? error.message : error)
      return []
    }
  }
  try {
    // The callbacks only know the IP-derived zone; it fills a gap until the browser reports one.
    await recordTimeZone(userId, timeZone, { replace: false }).catch((error: unknown) => console.error('Time zone could not be saved', error instanceof Error ? error.message : error))
    // A source the person turned off in Settings is not read (lib/suggestions/source-settings.ts).
    const gmailOn = async () => !(await disabledSuggestionSources(userId)).has('gmail')
    const notifications = (await read('Composio', () => ensureComposioTriggers(userId, { force: true }))).includes('gmail') && await gmailOn() ? await read('Gmail', () => currentGmail(userId)) : []
    // What was already there goes into the first briefing, not to the Coordinator one by one.
    await ingestNotifications(notifications, { route: false })
    await writeFirstBriefing(userId, await manualTimeZone(userId) ?? timeZone)
  } catch (error) {
    console.error('First briefing failed', error instanceof Error ? error.message : error)
  }
}
