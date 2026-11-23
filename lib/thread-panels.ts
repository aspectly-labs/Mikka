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

/** Persist the rail state — a partial write merges over what is stored, so a
 * client that only owns one field (the rail's open, or its active tab) never
 * clobbers the rest. False when the run is not the person's or the merged
 * state fails validation. */
export async function writeThreadPanels(ownerId: string, runId: string, patch: Partial<ThreadPanelState>): Promise<boolean> {
  const owned = await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, ownerId))).limit(1)
  if (!owned.length) return false
  const stored = await readThreadPanels(ownerId, runId)
  const state: ThreadPanelState = {
    tabs: patch.tabs ?? stored?.tabs ?? [],
    active: patch.active === undefined ? stored?.active ?? null : patch.active,
    open: patch.open ?? stored?.open ?? true,
  }
  if (!isThreadPanelState(state)) return false
  await db.insert(threadPanels).values({ userId: ownerId, runId, state })
    .onConflictDoUpdate({ target: [threadPanels.userId, threadPanels.runId], set: { state, updatedAt: new Date() } })
  return true
}
