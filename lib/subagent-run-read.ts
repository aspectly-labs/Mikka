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
 * (else dispatched) model, and the brief, as `[profile, model, brief]` with the profile as `[profileId, name, roles,
 * description, icon, color]`. Callers select it only for runs the reader owns. Every cited run in a Bot's chat sends
 * this text, so it stays short: positions instead of keys and one lookup of the Profile's mark (the citation read's
 * frozen wire budget, tests/read-cache-detail-egress.db.test.ts).
 */
export const SUBAGENT_FACTS_SQL = (r: string) => `jsonb_build_array((SELECT jsonb_build_array(a->'profileId',a->'name',\
a#>'{definition,roles}',a#>'{definition,description}',f.icon,f.color) FROM (SELECT ${r}."agentDefinition"->'agentProfile' a) x \
LEFT JOIN factory_agent_profiles f ON f.id::text=a->>'profileId' AND f."ownerId"=${r}."userId" WHERE a IS NOT NULL),\
coalesce(${r}."observedModel",${r}."agentDefinition"->>'model'),${r}.brief)`

/** The projected facts as the card reads them: a Default or malformed Profile is none. */
export function subagentFacts(value: unknown): SubagentFacts {
  const [stored, model, brief] = Array.isArray(value) ? value as unknown[] : []
  const [profileId, name, roles, description, icon, color] = Array.isArray(stored) ? stored as unknown[] : []
  const profile = Array.isArray(stored) ? threadProfile({ profileId, name, roles, description, icon, color }) : null
  return {
    profile: profile ? { name: profile.name, icon: profile.icon, color: profile.color } : null,
    model: typeof model === 'string' && model.trim() ? model : null,
    brief: normalizeBrief(typeof brief === 'string' ? brief : null),
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
  // The edge's rules (one owner, one Workspace, set once, never a loop) are checked here, then the write keeps the
  // first parent: main's schema (#2936 thread lifecycle) has no trigger for them.
  const { rows: [facts] } = await q.query(`WITH RECURSIVE up AS (
      SELECT id, "parentRunId", 0 AS depth FROM agent_runs WHERE id=$2 AND "userId"=$3
      UNION ALL SELECT r.id, r."parentRunId", up.depth + 1 FROM agent_runs r JOIN up ON r.id = up."parentRunId" WHERE up.depth < 64)
    SELECT c."workspaceId" AS "childWorkspace", c."parentRunId" AS "childParent", p."workspaceId" AS "parentWorkspace",
      EXISTS (SELECT 1 FROM up WHERE up.id=$1) AS cycle
    FROM agent_runs c JOIN agent_runs p ON p.id=$2 AND p."userId"=$3 WHERE c.id=$1 AND c."userId"=$3`, [input.childRunId, input.parentRunId, ownerId])
  if (!facts) throw new SubagentLinkError('runNotFound')
  if (input.childRunId === input.parentRunId || !facts.childWorkspace || facts.childWorkspace !== facts.parentWorkspace) throw new SubagentLinkError('subagentParentMismatch')
  if (facts.childParent && facts.childParent !== input.parentRunId) throw new SubagentLinkError('subagentParentFixed')
  if (facts.cycle) throw new SubagentLinkError('subagentParentCycle')
  const { rows } = await q.query(`UPDATE agent_runs c SET "parentRunId"=$2, "threadRelation"=coalesce(c."threadRelation", 'subagent'), brief=coalesce(c.brief, $4)
      WHERE c.id=$1 AND c."userId"=$3 AND (c."parentRunId" IS NULL OR c."parentRunId"=$2)
      RETURNING c.id`, [input.childRunId, input.parentRunId, ownerId, brief])
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
