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
            `SELECT title,status,"issuedIdentifier" AS identifier FROM issues WHERE id=$1 AND "workspaceId"=$2 AND content->'attrs'->'mikka'->>'deletedAt' IS NULL`, [ref.id, workspaceId])
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
            `SELECT r.status,COALESCE(i."issuedIdentifier"||' '||i.title,i.title) AS title FROM agent_runs r
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

export type ResolvedStructuredMention = {
  kind: import('@mikka/protocol/slash-commands').StructuredMentionKind
  id: string
  state: 'ok' | 'broken'
  title: string | null
  detail: string | null
}

/**
 * Resolve typed `mentions[]` sent alongside composer text (#3333).
 * Never throws per mention; unavailable or cross-tenant entities stay `'broken'`.
 */
export async function resolveStructuredMentions(
  database: Pick<Pool, 'query'>,
  ownerId: string,
  workspaceId: string | null,
  mentions: readonly import('@mikka/protocol/slash-commands').StructuredMention[],
): Promise<ResolvedStructuredMention[]> {
  const unique = mentions.filter(
    (m, idx, arr) => arr.findIndex(o => o.kind === m.kind && o.id === m.id) === idx,
  )
  return Promise.all(unique.map(async (m): Promise<ResolvedStructuredMention> => {
    const fail: ResolvedStructuredMention = { kind: m.kind, id: m.id, state: 'broken', title: m.label ?? null, detail: null }
    try {
      switch (m.kind) {
        case 'task':
        case 'pr':
        case 'thread':
        case 'bot': {
          const [res] = await resolveThreadReferences(database, ownerId, workspaceId, [{ type: m.kind, id: m.id }])
          return res ? { kind: m.kind, id: m.id, state: res.state, title: res.title, detail: res.detail } : fail
        }
        case 'file': {
          const [res] = await resolveThreadReferences(database, ownerId, workspaceId, [{ type: 'file', id: m.id }])
          if (res?.state === 'ok') return { kind: 'file', id: m.id, state: 'ok', title: res.title, detail: res.detail }
          const clean = m.id.trim()
          if (clean && !clean.startsWith('/') && !clean.includes('..') && !clean.includes('\0')) {
            return { kind: 'file', id: clean, state: 'ok', title: m.label ?? clean, detail: 'file' }
          }
          return fail
        }
        case 'folder': {
          return { kind: 'folder', id: m.id, state: 'ok', title: m.label ?? m.id, detail: 'folder' }
        }
        case 'chat': {
          if (!workspaceId) return fail
          const { rows: [row] } = await database.query<{ title: string | null }>(
            `SELECT c.title FROM conversations c JOIN conversation_members cm ON cm."conversationId"=c.id
             WHERE c.id=$1 AND c."workspaceId"=$2 AND cm."memberType"='user' AND cm."memberId"=$3 AND cm."leftAt" IS NULL LIMIT 1`,
            [m.id, workspaceId, ownerId],
          )
          return row ? { kind: 'chat', id: m.id, state: 'ok', title: row.title ?? m.label ?? m.id, detail: 'chat' } : fail
        }
        case 'person': {
          if (!workspaceId) return fail
          const { rows: [row] } = await database.query<{ name: string | null }>(
            `SELECT u.name FROM member mem JOIN "user" u ON u.id=mem."userId" WHERE mem."organizationId"=$1 AND u.id=$2 LIMIT 1`,
            [workspaceId, m.id],
          )
          return row ? { kind: 'person', id: m.id, state: 'ok', title: row.name ?? m.label ?? m.id, detail: 'member' } : fail
        }
        case 'device': {
          const { rows: [row] } = await database.query<{ name: string; kind: string }>(
            `SELECT name, kind FROM devices WHERE id=$1 AND "ownerId"=$2 AND "removedAt" IS NULL LIMIT 1`,
            [m.id, ownerId],
          )
          return row ? { kind: 'device', id: m.id, state: 'ok', title: row.name, detail: row.kind } : fail
        }
        case 'subagent': {
          const { rows: [row] } = await database.query<{ name: string | null; title: string | null; status: string }>(
            `SELECT name, title, status FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "threadRelation"='subagent' AND "deletedAt" IS NULL LIMIT 1`,
            [m.id, ownerId],
          )
          return row ? { kind: 'subagent', id: m.id, state: 'ok', title: row.name ?? row.title ?? m.label ?? m.id, detail: row.status } : fail
        }
        case 'plugin':
        case 'skill': {
          const { rows: [row] } = await database.query<{ name: string; slug: string; source: string }>(
            `SELECT name, slug, source FROM personal_skills WHERE user_id=$1 AND enabled=true AND (id::text=$2 OR lower(slug)=lower($2) OR lower(name)=lower($2)) LIMIT 1`,
            [ownerId, m.id],
          )
          return row
            ? { kind: m.kind, id: m.id, state: 'ok', title: row.name, detail: row.slug }
            : m.label
              ? { kind: m.kind, id: m.id, state: 'ok', title: m.label, detail: m.kind }
              : fail
        }
        case 'slack_channel': {
          const name = (m.label ?? m.id).replace(/^#/, '')
          return { kind: 'slack_channel', id: m.id, state: 'ok', title: `#${name}`, detail: `channel ${m.id}` }
        }
      }
    } catch {
      return fail
    }
  }))
}

/** Format resolved structured mentions as a concise context block. */
export function expandStructuredMentions(resolved: readonly ResolvedStructuredMention[]): string {
  if (!resolved.length) return ''
  const lines = resolved.map(r => r.state === 'ok'
    ? `- [${r.kind}] ${r.title ?? r.id}${r.detail ? ` (${r.detail})` : ''}`
    : `- [${r.kind}] <unavailable>`)
  return `<mentions>\n${lines.join('\n')}\n</mentions>\n\n`
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
