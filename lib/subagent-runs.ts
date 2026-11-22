import type { RunChainQueryable } from './run-chain'
import { threadProfile } from './issue-threads'
import type { SubagentFacts } from './subagent-card'

/**
 * Sub-agents as child runs (#2939, Figma "Chat+右栏" section 22). A child points at the run that dispatched it
 * (agent_runs."parentRunId"); the database keeps the edge to one owner and one Workspace, sets it once and refuses a
 * loop (drizzle/20261122125925_subagent_runs.sql). Its card needs only id, name, profile{icon,color}, model, status and
 * brief: name and mark come from the run's frozen Agent Profile, as every thread read draws them, the model from the
 * run itself, the brief from the line its dispatcher wrote. Multi-agent arbitration stays with #1729.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The most children one parent thread lists; a crew larger than this is not drawn in one reply. */
export const SUBAGENT_LIST_LIMIT = 50
export const SUBAGENT_BRIEF_MAX = 280

/** One line: whitespace folded, bounded to the column. Empty is none. */
export function normalizeBrief(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, ' ').trim() ?? ''
  return line ? [...line].slice(0, SUBAGENT_BRIEF_MAX).join('') : null
}

/**
 * The card facts of a run, as SQL over alias `r`: the custom Profile's frozen name with its current mark, the observed
 * (else dispatched) model, and the brief. Callers select it only for runs the reader owns.
 */
export const SUBAGENT_FACTS_SQL = (r: string) => `jsonb_build_object(
  'profile', CASE WHEN ${r}."agentDefinition"->'agentProfile' IS NULL THEN NULL ELSE jsonb_build_object(
    'profileId', ${r}."agentDefinition"->'agentProfile'->'profileId', 'name', ${r}."agentDefinition"->'agentProfile'->'name',
    'roles', ${r}."agentDefinition"->'agentProfile'->'definition'->'roles', 'description', ${r}."agentDefinition"->'agentProfile'->'definition'->'description',
    'icon', (SELECT p.icon FROM factory_agent_profiles p WHERE p.id::text=${r}."agentDefinition"->'agentProfile'->>'profileId' AND p."ownerId"=${r}."userId"),
    'color', (SELECT p.color FROM factory_agent_profiles p WHERE p.id::text=${r}."agentDefinition"->'agentProfile'->>'profileId' AND p."ownerId"=${r}."userId")) END,
  'model', coalesce(${r}."observedModel", ${r}."agentDefinition"->>'model'),
  'brief', ${r}.brief)`

/** The projected facts as the card reads them: a Default or malformed Profile is none. */
export function subagentFacts(value: unknown): SubagentFacts {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const profile = threadProfile(row.profile)
  return {
    profile: profile ? { name: profile.name, icon: profile.icon, color: profile.color } : null,
    model: typeof row.model === 'string' && row.model.trim() ? row.model : null,
    brief: normalizeBrief(typeof row.brief === 'string' ? row.brief : null),
  }
}

export class SubagentLinkError extends Error {
  constructor(readonly code: 'runNotFound' | 'subagentParentMismatch' | 'subagentParentFixed' | 'subagentParentCycle', options?: { cause?: unknown }) { super(code, options); this.name = 'SubagentLinkError' }
}

/**
 * Record that `childRunId` was dispatched by `parentRunId`, with the line it was handed. Both runs must be the owner's;
 * the trigger keeps them in one Workspace and refuses a second parent or a loop. Repeating the same link only updates
 * an empty brief, so a retried dispatch is safe.
 */
export async function linkSubagentRun(q: RunChainQueryable, ownerId: string, input: { parentRunId: string; childRunId: string; brief?: string | null }): Promise<void> {
  if (!UUID.test(input.parentRunId) || !UUID.test(input.childRunId)) throw new SubagentLinkError('runNotFound')
  const brief = normalizeBrief(input.brief)
  let rows: Record<string, unknown>[]
  try {
    ({ rows } = await q.query(`UPDATE agent_runs c SET "parentRunId"=$2, brief=coalesce(c.brief, $4)
      FROM agent_runs p WHERE c.id=$1 AND c."userId"=$3 AND p.id=$2 AND p."userId"=$3
      RETURNING c.id`, [input.childRunId, input.parentRunId, ownerId, brief]))
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    for (const code of ['subagentParentMismatch', 'subagentParentFixed', 'subagentParentCycle'] as const) if (message.includes(code)) throw new SubagentLinkError(code, { cause: error })
    throw error
  }
  if (!rows.length) throw new SubagentLinkError('runNotFound')
}

/** A dispatch's own one-line brief, on a run of the owner's that has none yet (a Bot's chat dispatch has no parent run). */
export async function recordDispatchBrief(q: RunChainQueryable, ownerId: string, runId: string, text: string | null | undefined): Promise<boolean> {
  const brief = normalizeBrief(text)
  if (!brief || !UUID.test(runId)) return false
  const { rows } = await q.query('UPDATE agent_runs SET brief=$3 WHERE id=$1 AND "userId"=$2 AND brief IS NULL RETURNING id', [runId, ownerId, brief])
  return rows.length > 0
}

export type SubagentRun = {
  /** The child thread's root run: opening it opens the sub-agent's thread. */
  id: string
  /** Its newest run, whose state the card shows. */
  latestRunId: string
  issueId: string | null
  /** The child thread's own short title, once it has one: the card's line when no brief was written. */
  title: string | null
  harness: string
  status: string
  outcome: string | null
  stopReason: string | null
  createdAt: string
  subagent: SubagentFacts
}

/**
 * The sub-agents a run dispatched, oldest first, each at the state of its own thread's newest run. Each run of a thread
 * shows its own under its reply. Owner-only: another member, another Workspace, a foreign or unknown run reads null.
 */
export async function readSubagentRuns(q: RunChainQueryable, input: { ownerId: string; workspaceId: string; runId: string }): Promise<SubagentRun[] | null> {
  if (!UUID.test(input.runId) || !UUID.test(input.workspaceId)) return null
  const { rows: [parent] } = await q.query('SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [input.runId, input.ownerId])
  if (!parent || parent.workspaceId !== input.workspaceId) return null
  const { rows } = await q.query(`
    SELECT c.id, latest.id AS "latestRunId", c."issueId", c.title, coalesce(a.harness, latest."agentDefinition"->>'harness', '') AS harness,
      latest.status, latest.outcome, latest."stopReason", c."createdAt", ${SUBAGENT_FACTS_SQL('latest')} AS facts, c.brief AS "rootBrief"
    FROM agent_runs c
    CROSS JOIN LATERAL (
      WITH RECURSIVE chain AS (
        SELECT r.id, r."createdAt", 0 AS depth FROM agent_runs r WHERE r.id=c.id
        UNION ALL SELECT n.id, n."createdAt", chain.depth+1 FROM chain JOIN agent_runs n
          ON chain.id IN (n."continuesRunId", n."retryOf") AND n."userId"=c."userId" AND n."workspaceId"=c."workspaceId"
          AND n."issueId" IS NOT DISTINCT FROM c."issueId" WHERE chain.depth<64
      ) SELECT r.* FROM chain JOIN agent_runs r ON r.id=chain.id ORDER BY chain."createdAt" DESC, chain.id DESC LIMIT 1
    ) latest
    LEFT JOIN agents a ON a.id=latest."agentId"
    WHERE c."parentRunId"=$1 AND c."userId"=$2 AND c."workspaceId"=$3
    ORDER BY c."createdAt", c.id LIMIT $4`,
  [input.runId, input.ownerId, input.workspaceId, SUBAGENT_LIST_LIMIT])
  return rows.map(row => {
    const facts = subagentFacts(row.facts)
    return {
      id: String(row.id), latestRunId: String(row.latestRunId), issueId: (row.issueId as string | null) ?? null, title: (row.title as string | null) ?? null, harness: String(row.harness),
      status: String(row.status), outcome: (row.outcome as string | null) ?? null, stopReason: (row.stopReason as string | null) ?? null,
      createdAt: new Date(row.createdAt as string | Date).toISOString(),
      // The brief belongs to the dispatch: a continuation keeps the line its first run was handed.
      subagent: { ...facts, brief: normalizeBrief(row.rootBrief as string | null) ?? facts.brief },
    }
  })
}
