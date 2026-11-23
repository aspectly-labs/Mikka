import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'

/** #2941 item 2: a typed reference the composer attaches to a message. `id` is
 * the type's natural key — task: issue uuid, pr: the pull url, thread: run
 * uuid, bot: bot uuid, file: coding_workspace_mentions id — and `offset` is
 * the composer's caret anchor for UI round-trips only. */
export const threadReference = z.object({
  type: z.enum(['file', 'task', 'pr', 'thread', 'bot']),
  id: z.string().min(1).max(2048),
  offset: z.number().int().min(0).optional(),
}).strict()
export type ThreadReference = z.infer<typeof threadReference>

export type ResolvedReference = ThreadReference & {
  state: 'ok' | 'broken'
  title: string | null
  detail: string | null
}

const broken = (ref: ThreadReference): ResolvedReference => ({ ...ref, state: 'broken', title: null, detail: null })

/** Resolve each reference against the person's own workspace data. Anything
 * deleted, out of scope or unreachable is 'broken' — never throws, so the
 * composer can show the marker and the send still decides what to do. */
export async function resolveThreadReferences(database: Pick<Pool, 'query'>,
  ownerId: string, workspaceId: string | null, refs: readonly ThreadReference[]): Promise<ResolvedReference[]> {
  return Promise.all(refs.map(async ref => {
    try {
      switch (ref.type) {
        case 'task': {
          if (!workspaceId) return broken(ref)
          const { rows: [row] } = await database.query<{ title: string; status: string; identifier: string | null }>(
            `SELECT title,status,identifier FROM issues WHERE id=$1 AND "workspaceId"=$2 AND content->'attrs'->'mikka'->>'deletedAt' IS NULL`, [ref.id, workspaceId])
          return row ? { ...ref, state: 'ok', title: row.title, detail: `${row.identifier ?? ''} ${row.status}`.trim() } : broken(ref)
        }
        case 'pr': {
          const { rows: [row] } = await database.query<{ title: string | null; state: string | null }>(
            `SELECT "pullRequest"->>'title' AS title,"pullRequest"->>'state' AS state FROM run_publications
              WHERE "userId"=$1 AND "pullRequest"->>'url'=$2 LIMIT 1`, [ownerId, ref.id])
          return row ? { ...ref, state: 'ok', title: row.title, detail: row.state } : broken(ref)
        }
        case 'thread': {
          const { rows: [row] } = await database.query<{ status: string; title: string | null }>(
            `SELECT r.status,COALESCE(i.identifier||' '||i.title,i.title) AS title FROM agent_runs r
              LEFT JOIN issues i ON i.id=r."issueId" WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId" IS NOT DISTINCT FROM $3`,
            [ref.id, ownerId, workspaceId])
          return row ? { ...ref, state: 'ok', title: row.title, detail: row.status } : broken(ref)
        }
        case 'bot': {
          if (!workspaceId) return broken(ref)
          const { rows: [row] } = await database.query<{ name: string; archivedAt: Date | null }>(
            `SELECT name,"archivedAt" FROM bots WHERE id=$1 AND "workspaceId"=$2`, [ref.id, workspaceId])
          return row ? { ...ref, state: 'ok', title: row.name, detail: row.archivedAt ? 'archived' : 'active' } : broken(ref)
        }
        case 'file': {
          const { rows: [row] } = await database.query<{ files: { path?: string; range?: { startLine?: number; endLine?: number } }[] }>(
            `SELECT files FROM coding_workspace_mentions WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "expiresAt">clock_timestamp()`,
            [ref.id, ownerId, workspaceId])
          if (!row) return broken(ref)
          const file = row.files?.[ref.offset ?? 0] ?? row.files?.[0]
          if (!file?.path) return broken(ref)
          const range = file.range?.startLine != null ? `:${file.range.startLine}${file.range.endLine != null ? `-${file.range.endLine}` : ''}` : ''
          return { ...ref, state: 'ok', title: `${file.path}${range}`, detail: `${row.files.length} file${row.files.length === 1 ? '' : 's'}` }
        }
      }
    } catch {
      return broken(ref)
    }
  }))
}

/** The context block the expanded references add in front of the message the
 * machine sees: one line per reference, broken ones marked so the agent does
 * not guess at a dead link. */
export function expandReferences(resolved: readonly ResolvedReference[]): string {
  if (!resolved.length) return ''
  const lines = resolved.map(r => r.state === 'ok'
    ? `- [${r.type}] ${r.title ?? r.id}${r.detail ? ` (${r.detail})` : ''}`
    : `- [${r.type}] <unavailable>`)
  return `<references>\n${lines.join('\n')}\n</references>\n\n`
}
