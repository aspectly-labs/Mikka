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

export async function searchThreadReferences(reader: IssueReader, workspaceId: string, query: string, kind?: ThreadReference['kind']) {
  const userId = typeof reader === 'string' ? reader : reader.id
  return withTaskWorkspace(reader, workspaceId, async () => {
    // Match names in JS like the other kinds: PostgreSQL's lower() folds final ς differently and would drop hits.
    const botsQuery = db.select({ id: bots.id, name: bots.name }).from(bots)
      .where(and(eq(bots.workspaceId, workspaceId), isNull(bots.archivedAt))).orderBy(asc(bots.createdAt)).$dynamic()
    const [tasks, threads, prs, botRows] = await Promise.all([
      kind && kind !== 'task' ? null : searchIssues(db, { userId, workspaceId, params: parseSearchParams(new URLSearchParams({ q: query, limit: '8', workspaceId })) }),
      kind && kind !== 'thread' ? null : conversationDirectory(pool, reader, workspaceId, { search: query }),
      kind && kind !== 'pr' ? [] : pullRequests(reader, workspaceId, query),
      // No query needs only the picker's eight; a real query stays uncapped so the filter always precedes any cap.
      kind && kind !== 'bot' ? null : query.trim() ? botsQuery : botsQuery.limit(8),
    ])
    const needle = query.toLowerCase().replace(/ς/g, 'σ')
    return [
      ...tasks?.items.map(item => ({ kind: 'task' as const, id: item.id, title: [item.identifier, item.title].filter(Boolean).join(' ') })) ?? [],
      ...threads?.items.slice(0, 8).map(item => ({ kind: 'thread' as const, id: item.id, title: item.title,
        ...(item.kind === 'chat' ? { conversationKind: 'chat' as const } : {}) })) ?? [],
      ...prs,
      ...botRows?.filter(bot => !needle || bot.name.toLowerCase().replace(/ς/g, 'σ').includes(needle)).slice(0, 8)
        .map(bot => ({ kind: 'bot' as const, id: bot.id, title: bot.name })) ?? [],
    ]
  })
}
