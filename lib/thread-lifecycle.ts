import { readRunChain, type RunChain, type RunChainQueryable } from './run-chain'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'

/**
 * A thread's lifecycle (#2936, Figma 1318:2 section 13): delete and restore, tags, and the seed of an automation made
 * from it. A thread is its root run and the runs that continue it (lib/run-chain.ts). Only its owner, in the Workspace
 * the thread belongs to, acts on it: any other reader (a teammate, the owner in another Workspace, an unknown run)
 * gets null, which the action reports as runNotFound.
 */

/** How long a deleted thread can be restored. After that it stays hidden and restore answers runNotFound. */
export const THREAD_RESTORE_DAYS = 30
export const THREAD_TAG_MAX = 10
export const THREAD_TAG_LENGTH = 32

type Actor = { ownerId: string; workspaceId: string; runId: string }

/** The owner's chain, when every run of it is in `workspaceId`. */
export async function ownedThreadChain(q: RunChainQueryable, { ownerId, workspaceId, runId }: Actor): Promise<RunChain | null> {
  const chain = await readRunChain(q, ownerId, runId)
  if (!chain) return null
  const ids = chain.attempts.map(attempt => attempt.runId)
  const { rows: [row] } = await q.query('SELECT count(*)::int AS n FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "workspaceId"=$3', [ids, ownerId, workspaceId])
  return Number(row?.n) === ids.length ? chain : null
}

export type ThreadDeletion = { threadId: string; deletedAt: Date | null; restorableUntil: Date | null }

function deletion(threadId: string, deletedAt: Date | null): ThreadDeletion {
  return { threadId, deletedAt, restorableUntil: deletedAt ? new Date(deletedAt.getTime() + THREAD_RESTORE_DAYS * 86_400_000) : null }
}

/**
 * Deletes a thread: every run of its chain is marked, so it leaves every list at once; nothing is removed. A thread
 * that is still working is not deleted (stop it first). Deleting it again keeps the first date.
 */
export async function deleteThread(q: RunChainQueryable, actor: Actor): Promise<ThreadDeletion | 'working' | null> {
  const chain = await ownedThreadChain(q, actor)
  if (!chain) return null
  if (chain.attempts.some(attempt => (UNFINISHED_RUN_STATUSES as readonly string[]).includes(attempt.status))) return 'working'
  const { rows } = await q.query(`UPDATE agent_runs SET "threadDeletedAt"=coalesce("threadDeletedAt",now()),"updatedAt"=now()
    WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "workspaceId"=$3 RETURNING id::text,"threadDeletedAt"`,
  [chain.attempts.map(attempt => attempt.runId), actor.ownerId, actor.workspaceId])
  const root = rows.find(row => row.id === chain.rootRunId)
  return root ? deletion(chain.rootRunId, root.threadDeletedAt as Date) : null
}

/** Brings a deleted thread back within THREAD_RESTORE_DAYS. A thread that was never deleted is answered as it is. */
export async function restoreThread(q: RunChainQueryable, actor: Actor): Promise<ThreadDeletion | null> {
  const chain = await ownedThreadChain(q, actor)
  if (!chain) return null
  const ids = chain.attempts.map(attempt => attempt.runId)
  const { rows: [root] } = await q.query('SELECT "threadDeletedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2', [chain.rootRunId, actor.ownerId])
  if (!root) return null
  if (!root.threadDeletedAt) return deletion(chain.rootRunId, null)
  const { rowCount } = await q.query(`UPDATE agent_runs SET "threadDeletedAt"=NULL,"updatedAt"=now()
    WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "workspaceId"=$3
      AND (SELECT "threadDeletedAt" FROM agent_runs WHERE id=$4) > now()-make_interval(days => $5)`,
  [ids, actor.ownerId, actor.workspaceId, chain.rootRunId, THREAD_RESTORE_DAYS]) as unknown as { rowCount: number }
  return rowCount ? deletion(chain.rootRunId, null) : null
}

/**
 * Tags as the owner typed them: trimmed, inner whitespace folded, duplicates (ignoring case) dropped, at most
 * THREAD_TAG_MAX of at most THREAD_TAG_LENGTH characters. Anything else is null: the action refuses it.
 */
export function normalizeThreadTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > THREAD_TAG_MAX * 2) return null
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const tag = item.replace(/\s+/g, ' ').trim()
    if (!tag) continue
    if ([...tag].length > THREAD_TAG_LENGTH) return null
    if (!tags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) tags.push(tag)
  }
  return tags.length > THREAD_TAG_MAX ? null : tags
}

/** The thread's tags; with `tags`, replaces them first. */
export async function threadTags(q: RunChainQueryable, actor: Actor, tags?: string[]): Promise<{ threadId: string; tags: string[] } | null> {
  const chain = await ownedThreadChain(q, actor)
  if (!chain) return null
  const { rows: [row] } = tags
    ? await q.query('UPDATE agent_runs SET "threadTags"=$4::text[],"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3 AND "threadDeletedAt" IS NULL RETURNING "threadTags"', [chain.rootRunId, actor.ownerId, actor.workspaceId, tags])
    : await q.query('SELECT "threadTags" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3 AND "threadDeletedAt" IS NULL', [chain.rootRunId, actor.ownerId, actor.workspaceId])
  return row ? { threadId: chain.rootRunId, tags: row.threadTags as string[] } : null
}

/**
 * What 「做成自动化」 opens the automation editor with: each run goes to this thread (eachRun 'existing_thread', the
 * thread's root as singleThreadId), titled as the thread is and asking what the thread was first asked. The editor saves
 * it through createAutomation, which checks the thread again. A thread with no task cannot run again, so it has none.
 */
export async function threadAutomationSeed(q: RunChainQueryable, actor: Actor): Promise<{ singleThreadId: string; title: string; prompt: string } | 'noTask' | null> {
  const chain = await ownedThreadChain(q, actor)
  if (!chain) return null
  const { rows: [root] } = await q.query(`SELECT r."issueId",coalesce(r.title,i.title,'') AS title,
      CASE WHEN r."promptTaskStart">=0 AND r."promptTaskLength" BETWEEN 0 AND length(r.prompt)-r."promptTaskStart"::bigint
        THEN substr(r.prompt,r."promptTaskStart"+1,r."promptTaskLength") ELSE r.prompt END AS asked
    FROM agent_runs r LEFT JOIN issues i ON i.id=r."issueId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3 AND r."threadDeletedAt" IS NULL`, [chain.rootRunId, actor.ownerId, actor.workspaceId])
  if (!root) return null
  if (!root.issueId) return 'noTask'
  return { singleThreadId: chain.rootRunId, title: String(root.title).slice(0, 200), prompt: String(root.asked ?? '').trim().slice(0, 10_000) }
}
