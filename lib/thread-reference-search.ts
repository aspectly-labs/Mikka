import 'server-only'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { bots, issues } from '@/lib/db/schema'
import { parseSearchParams, searchIssues } from '@/lib/issue-search'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { pullRequestSchema } from '@/lib/issue-metadata'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { conversationDirectory } from '@/lib/conversation-directory'
import type { ThreadReference } from './thread-references'

/** Only PRs attached to readable tasks are candidates. Match the title, URL or number before limiting. */
async function pullRequests(reader: IssueReader, workspaceId: string, query: string): Promise<ThreadReference[]> {
  const { predicate } = await issueVisibility(reader, false, workspaceId, db, { withTeamLinks: false })
  const rows = await db.execute<{ url: string; title: string | null; state: string }>(sql`
    SELECT DISTINCT ON (lower(link.url)) link.url, link.receipt->>'title' AS title, link.receipt->>'state' AS state
    FROM ${issues} JOIN task_pull_links link ON link."issueId"=${issues.id}
    WHERE ${predicate} AND (strpos(lower(coalesce(link.receipt->>'title','')), lower(${query}))>0
      OR strpos(lower(link.url), lower(${query}))>0 OR ('#'||substring(link.url from '/pull/([0-9]+)$'))=${query})
    ORDER BY lower(link.url), ${issues.updatedAt} DESC, ${issues.id}, link.ordinal LIMIT 8`)
  return rows.rows.flatMap(row => {
    const result = pullRequestSchema.safeParse({ url: row.url, title: row.title ?? undefined, state: row.state })
    return result.success ? [{ kind: 'pr' as const, id: result.data.url, title: result.data.title || result.data.url }] : []
  })
}

/** What could be the start of a task's code: `CHAT`, `chat-`, `CHAT-1`. */
const CODE_START = /^[a-z][a-z0-9_]{0,63}(?:-\d{0,16})?$/i

/**
 * Tasks whose code starts with what was typed, in any case (`@CHAT`, `@chat-1`), as a code is searched in Linear
 * or Capy. The task search resolves only a whole identifier through its aliases; a code typed in part found nothing.
 */
async function tasksByCode(reader: IssueReader, workspaceId: string, query: string) {
  if (!CODE_START.test(query)) return []
  const { predicate } = await issueVisibility(reader, false, workspaceId, db, { withTeamLinks: false })
  const start = query.toUpperCase().replace(/[\\%_]/g, character => '\\' + character) + '%'
  const rows = await db.execute<{ id: string; title: string; code: string }>(sql`
    SELECT ${issues.id} AS id, ${issues.title} AS title, ${issues.issuedIdentifier} AS code FROM ${issues}
    WHERE ${predicate} AND (${issues.content}->'attrs'->'mikka'->>'deletedAt') IS NULL
      AND upper(${issues.issuedIdentifier}) LIKE ${start}
    ORDER BY length(${issues.issuedIdentifier}), ${issues.updatedAt} DESC, ${issues.id} LIMIT 8`)
  return rows.rows.map(row => ({ kind: 'task' as const, id: row.id, title: [row.code, row.title].filter(Boolean).join(' ') }))
}

async function searchDevices(userId: string, needle: string): Promise<ThreadReference[]> {
  const { rows } = await pool.query<{ id: string; name: string; kind: string }>(
    `SELECT id, name, kind FROM devices WHERE "ownerId"=$1 AND "removedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 50`,
    [userId],
  )
  return rows
    .filter(d => !needle || d.name.toLowerCase().replace(/ς/g, 'σ').includes(needle))
    .slice(0, 8)
    .map(d => ({ kind: 'device' as const, id: d.id, title: d.name, detail: d.kind }))
}

async function searchSubagents(userId: string, workspaceId: string, needle: string, runId?: string): Promise<ThreadReference[]> {
  let chainRunIds: string[] | null = null
  if (runId) {
    const { readRunChain } = await import('@/lib/run-chain')
    const chain = await readRunChain(pool, userId, runId)
    chainRunIds = chain ? chain.attempts.map(attempt => attempt.runId) : [runId]
  }
  const { rows } = chainRunIds
    ? await pool.query<{ id: string; name: string | null; title: string | null; status: string }>(
        `SELECT id, name, title, status FROM agent_runs
         WHERE "userId"=$1 AND "workspaceId"=$2 AND "parentRunId"=ANY($3::uuid[]) AND "threadRelation"='subagent' AND "deletedAt" IS NULL
         ORDER BY "createdAt" DESC LIMIT 50`,
        [userId, workspaceId, chainRunIds],
      )
    : await pool.query<{ id: string; name: string | null; title: string | null; status: string }>(
        `SELECT id, name, title, status FROM agent_runs
         WHERE "userId"=$1 AND "workspaceId"=$2 AND "threadRelation"='subagent' AND "deletedAt" IS NULL
         ORDER BY "createdAt" DESC LIMIT 50`,
        [userId, workspaceId],
      )
  return rows
    .map(r => ({ kind: 'subagent' as const, id: r.id, title: r.name || r.title || `Subagent ${r.id.slice(0, 8)}`, detail: r.status }))
    .filter(r => !needle || r.title.toLowerCase().replace(/ς/g, 'σ').includes(needle))
    .slice(0, 8)
}

async function searchPlugins(userId: string, needle: string): Promise<ThreadReference[]> {
  const { rows } = await pool.query<{ id: string; name: string; slug: string; source: string }>(
    `SELECT id, name, slug, source FROM personal_skills WHERE user_id=$1 AND enabled=true ORDER BY created_at DESC LIMIT 100`,
    [userId],
  ).catch(() => ({ rows: [] as { id: string; name: string; slug: string; source: string }[] }))
  return rows
    .filter(p => !needle || p.name.toLowerCase().replace(/ς/g, 'σ').includes(needle) || p.slug.toLowerCase().includes(needle))
    .slice(0, 8)
    .map(p => ({ kind: 'plugin' as const, id: p.id, title: p.name, detail: p.slug }))
}

export async function searchThreadReferences(
  reader: IssueReader,
  workspaceId: string,
  query: string,
  kind?: ThreadReference['kind'],
  options?: { runId?: string },
) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const needle = query.toLowerCase().replace(/ς/g, 'σ')
  return withTaskWorkspace(reader, workspaceId, async () => {
    // Match names in JS like the other kinds: PostgreSQL's lower() folds final ς differently and would drop hits.
    const botsQuery = db.select({ id: bots.id, name: bots.name }).from(bots)
      .where(and(eq(bots.workspaceId, workspaceId), isNull(bots.archivedAt))).orderBy(asc(bots.createdAt)).$dynamic()
    const [tasks, coded, threads, prs, botRows, deviceRows, subagentRows, pluginRows] = await Promise.all([
      kind && kind !== 'task' ? null : searchIssues(db, { userId, workspaceId, params: parseSearchParams(new URLSearchParams({ q: query, limit: '8', workspaceId })) }),
      kind && kind !== 'task' ? [] : tasksByCode(reader, workspaceId, query),
      kind && kind !== 'thread' ? null : conversationDirectory(pool, reader, workspaceId, { search: query }),
      kind && kind !== 'pr' ? [] : pullRequests(reader, workspaceId, query),
      // No query needs only the picker's eight; a real query stays uncapped so the filter always precedes any cap.
      kind && kind !== 'bot' ? null : query.trim() ? botsQuery : botsQuery.limit(8),
      kind && kind !== 'device' ? [] : searchDevices(userId, needle),
      kind && kind !== 'subagent' ? [] : searchSubagents(userId, workspaceId, needle, options?.runId),
      kind && kind !== 'plugin' ? [] : searchPlugins(userId, needle),
    ])
    return [
      // A code's matches first, then the title search's; each task once, eight at most.
      ...[...coded, ...tasks?.items.map(item => ({ kind: 'task' as const, id: item.id, title: [item.identifier, item.title].filter(Boolean).join(' ') })) ?? []]
        .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 8),
      ...threads?.items.slice(0, 8).map(item => ({ kind: 'thread' as const, id: item.id, title: item.title,
        ...(item.kind === 'chat' ? { conversationKind: 'chat' as const } : {}) })) ?? [],
      ...prs,
      ...botRows?.filter(bot => !needle || bot.name.toLowerCase().replace(/ς/g, 'σ').includes(needle)).slice(0, 8)
        .map(bot => ({ kind: 'bot' as const, id: bot.id, title: bot.name })) ?? [],
      ...deviceRows,
      ...subagentRows,
      ...pluginRows,
    ]
  })
}
