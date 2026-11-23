import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { agentRuns, threadPanels } from './db/schema'

/** The rail's per-thread state (#2935 item 2): the panel tabs the person opened,
 * which is active and whether the rail is open. */
export interface ThreadPanelState {
  tabs: string[]
  active: string | null
  open: boolean
}

const PANEL_KEYS = /^(overview|changes|files|setup|browser|pull-request|crew:[a-z]+)$/

export function isThreadPanelState(value: unknown): value is ThreadPanelState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as { tabs?: unknown; active?: unknown; open?: unknown }
  return Array.isArray(state.tabs) && state.tabs.length <= 16
    && state.tabs.every(tab => typeof tab === 'string' && PANEL_KEYS.test(tab))
    && (state.active === null || (typeof state.active === 'string' && PANEL_KEYS.test(state.active)))
    && typeof state.open === 'boolean'
}

/** The person's stored rail state for a thread, or null. Ownership is fenced by
 * the userId half of the primary key — a thread someone else owns returns null. */
export async function readThreadPanels(ownerId: string, runId: string): Promise<ThreadPanelState | null> {
  const [row] = await db.select({ state: threadPanels.state }).from(threadPanels)
    .where(and(eq(threadPanels.userId, ownerId), eq(threadPanels.runId, runId))).limit(1)
  return row && isThreadPanelState(row.state) ? row.state : null
}

/** Persist the rail state; false when the run is not the person's (no row is
 * written for someone else's thread). */
export async function writeThreadPanels(ownerId: string, runId: string, state: ThreadPanelState): Promise<boolean> {
  if (!isThreadPanelState(state)) return false
  const owned = await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, ownerId))).limit(1)
  if (!owned.length) return false
  await db.insert(threadPanels).values({ userId: ownerId, runId, state })
    .onConflictDoUpdate({ target: [threadPanels.userId, threadPanels.runId], set: { state, updatedAt: new Date() } })
  return true
}
