import 'server-only'
import { and, desc, eq, gte } from 'drizzle-orm'
import { afterJob } from '@/lib/background'
import { db, pool } from '@/lib/db'
import { briefings } from '@/lib/db/schema'
import { listPendingActions, type PendingAction } from '@/lib/pending-action-store'
import { ACTION_LOCALES, type ActionLocale } from '@/lib/suggestions/action-title'
import { rememberLocale } from '@/lib/suggestions/action-title-server'
import { BRIEFING_WINDOW_MS } from '@/lib/suggestions/briefing'
import { ensureComposioTriggers } from '@/lib/suggestions/sources'
import { listSuggestions, recordTimeZone, todaysBriefing } from '@/lib/suggestions/store'
import { manualTimeZone } from '@/lib/suggestions/time-zone'
import { pendingActionsOutsideToken, suggestionsOutsideToken } from '@/lib/tokens/scope'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import type { RequestWorkspaceUser } from '@/lib/request-workspace'

export interface MobileProactiveBriefing {
  id: string
  localDate: string
  kind: string
  total: number
  counts: Record<string, number>
  highlights: string[]
  createdAt: string
}

export interface MobileSuggestionCard {
  id: string
  source: string
  action: string
  title: string
  actionTitle: string | null
  url: string | null
  actor: string | null
  required: boolean
  occurredAt: string
}

export interface MobileInProgressSuggestionCard extends MobileSuggestionCard {
  state: string
  runId: string | null
  subagentId: string | null
}

export interface MobileProactiveCardsResponse {
  workspaceId: string
  observedAt: string
  briefing: MobileProactiveBriefing | null
  pendingActions: PendingAction[]
  suggestions: {
    inProgress: MobileInProgressSuggestionCard[]
    items: MobileSuggestionCard[]
  }
}

async function startedSuggestions(userId: string, ids: readonly string[]) {
  if (!ids.length) return new Map<string, { status: string; runId: string | null; subagentId: string | null }>()
  const { rows } = await pool.query<{
    suggestionId: string
    status: string
    runId: string | null
    subagentId: string | null
  }>(
    'SELECT "suggestionId",status,"runId","subagentId" FROM suggestion_executions WHERE "ownerId"=$1 AND "suggestionId"=ANY($2::uuid[])',
    [userId, ids],
  )
  return new Map(rows.map(row => [row.suggestionId, row]))
}

async function latestBriefingReadOnly(userId: string) {
  const [latest] = await db
    .select()
    .from(briefings)
    .where(and(eq(briefings.userId, userId), gte(briefings.createdAt, new Date(Date.now() - BRIEFING_WINDOW_MS))))
    .orderBy(desc(briefings.localDate))
    .limit(1)
  if (!latest || (latest.kind === 'daily' && !latest.total)) return null
  return latest
}

/**
 * Unified authorized read of Coordinator proactive cards for mobile:
 * - active pending actions (approve/decline via `POST /api/mobile/pending-actions/:id`)
 * - active suggestions & in-progress suggestion runs (act via `POST|DELETE /api/mobile/suggestions/:id`)
 * - today's daily briefing summary
 *
 * When `readonly` is true, performs zero writes (no briefing creation, no
 * trigger sync, no timezone/locale persistence).
 */
export async function readMobileProactiveCards(
  user: RequestWorkspaceUser,
  options: {
    timeZone?: string | null
    ipTimeZone?: string | null
    locale?: string | null
    readonly?: boolean
  } = {},
): Promise<MobileProactiveCardsResponse> {
  const observedAt = new Date().toISOString()
  const context = await loadWorkspaceContext(undefined, user)

  if (!options.readonly) {
    afterJob('after:composio-triggers', async () => {
      try {
        await ensureComposioTriggers(user.id)
      } catch (error) {
        console.error('Composio trigger check failed', error instanceof Error ? error.message : error)
      }
    })
    if (options.timeZone) {
      const tz = options.timeZone
      afterJob('after:record-time-zone', async () => {
        try {
          await recordTimeZone(user.id, tz)
        } catch (error) {
          console.error('Time zone could not be saved', error instanceof Error ? error.message : error)
        }
      })
    }
    if (options.locale && (ACTION_LOCALES as readonly string[]).includes(options.locale)) {
      const loc = options.locale as ActionLocale
      afterJob('after:remember-locale', async () => {
        try {
          await rememberLocale(user.id, loc)
        } catch (error) {
          console.error('Remembering the locale failed', error instanceof Error ? error.message : error)
        }
      })
    }
  }

  const timeZone = options.readonly
    ? null
    : (await manualTimeZone(user.id)) ?? options.timeZone ?? options.ipTimeZone ?? null

  const [briefingRow, rawPending, rawSuggestions] = await Promise.all([
    options.readonly ? latestBriefingReadOnly(user.id) : todaysBriefing(user.id, timeZone),
    listPendingActions(user.id),
    listSuggestions(user.id),
  ])

  const [outsidePending, outsideSuggestions, executions] = await Promise.all([
    pendingActionsOutsideToken(
      user,
      rawPending.map(item => item.id),
    ),
    suggestionsOutsideToken(
      user,
      rawSuggestions.map(item => item.id),
    ),
    startedSuggestions(
      user.id,
      rawSuggestions.map(item => item.id),
    ),
  ])

  const pendingActions = rawPending.filter(item => !outsidePending.has(item.id))
  const visibleSuggestions = rawSuggestions.filter(item => !outsideSuggestions.has(item.id))

  const view = (item: (typeof visibleSuggestions)[number]): MobileSuggestionCard => ({
    id: item.id,
    source: item.source,
    action: item.action,
    title: item.title,
    actionTitle: item.actionTitle ?? null,
    url: item.url ?? null,
    actor: item.actor ?? null,
    required: item.required,
    occurredAt: item.occurredAt instanceof Date ? item.occurredAt.toISOString() : String(item.occurredAt),
  })

  const inProgress: MobileInProgressSuggestionCard[] = []
  const items: MobileSuggestionCard[] = []
  for (const item of visibleSuggestions) {
    const execution = executions.get(item.id)
    if (!execution) {
      items.push(view(item))
    } else if (execution.status === 'starting' || execution.status === 'running') {
      inProgress.push({
        ...view(item),
        state: execution.status,
        runId: execution.runId ?? null,
        subagentId: execution.subagentId ?? null,
      })
    }
  }

  const briefing: MobileProactiveBriefing | null = briefingRow
    ? {
        id: briefingRow.id,
        localDate: briefingRow.localDate,
        kind: briefingRow.kind,
        total: briefingRow.total,
        counts: (briefingRow.counts ?? {}) as Record<string, number>,
        highlights: Array.isArray(briefingRow.highlights) ? (briefingRow.highlights as string[]) : [],
        createdAt:
          briefingRow.createdAt instanceof Date
            ? briefingRow.createdAt.toISOString()
            : String(briefingRow.createdAt),
      }
    : null

  return {
    workspaceId: context.workspace.id,
    observedAt,
    briefing,
    pendingActions,
    suggestions: { inProgress, items },
  }
}
