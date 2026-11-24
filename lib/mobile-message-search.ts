import 'server-only'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { escapeLike } from '@/lib/issue-search'
import { maskCredentials } from '@/lib/secrets/mask'
import { COORDINATOR_WELCOME_MARK } from '@/lib/agent-welcome'
import { HANDOFF_PREFIX } from '@/lib/attention/handoff'
import { tokenWorkspace } from '@/lib/tokens/principal'
import {
  buildMessageSearchSnippet,
  encodeMessageSearchCursor,
  type MessageSearchInput,
  type MobileMessageSearchHit,
  type MobileMessageSearchPage,
} from './mobile-message-search-contract'

export class MobileMessageSearchAccessError extends Error {}

type SearchUser = { id: string; [tokenWorkspace]?: string }

async function requireActiveWorkspaceMember(user: SearchUser, workspaceId: string) {
  if (user[tokenWorkspace] && user[tokenWorkspace] !== workspaceId) {
    throw new MobileMessageSearchAccessError('workspaceAccessDenied')
  }
  const [row] = await workspaceDb
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, user.id),
        eq(workspaceMembers.status, 'active'),
      ),
    )
    .limit(1)
  if (!row) throw new MobileMessageSearchAccessError('workspaceAccessDenied')
}

interface RawHitRow {
  kind: 'bot' | 'group' | 'thread'
  messageId: string
  targetId: string
  title: string
  body: string
  authorType: 'user' | 'bot' | 'agent'
  position: string | null
  createdAt: string
}

/**
 * Authorized full-text message search across the caller's visible Bot chats,
 * group/named conversations, and task/agent thread messages within one active
 * workspace. Ownership and membership predicates are enforced in SQL before
 * `LIMIT`, and workspace membership is re-verified before returning results.
 */
export async function searchMobileMessages(
  user: SearchUser,
  input: MessageSearchInput,
): Promise<MobileMessageSearchPage> {
  await requireActiveWorkspaceMember(user, input.workspaceId)

  const pattern = `%${escapeLike(input.q)}%`
  const includeBots = (input.scope === 'all' || input.scope === 'bot') && !input.conversationId
  const includeGroups = (input.scope === 'all' || input.scope === 'group') && !input.botId
  const includeThreads = (input.scope === 'all' || input.scope === 'thread') && !input.botId && !input.conversationId

  // Parameters:
  // $1: userId, $2: workspaceId, $3: pattern, $4: cursorTime|null, $5: cursorId|null,
  // $6: botId|null, $7: conversationId|null, $8: welcomePrefix, $9: handoffPrefix, $10: limit + 1
  const params: unknown[] = [
    user.id,
    input.workspaceId,
    pattern,
    input.cursor?.time ?? null,
    input.cursor?.id ?? null,
    input.botId,
    input.conversationId,
    COORDINATOR_WELCOME_MARK,
    HANDOFF_PREFIX,
    input.limit + 1,
  ]

  const branches: string[] = []

  if (includeBots) {
    branches.push(`
      SELECT
        'bot'::text AS kind,
        m.id AS "messageId",
        b.id AS "targetId",
        b.name AS title,
        txt.body AS body,
        CASE WHEN m.message->>'role' = 'user' THEN 'user'::text ELSE 'bot'::text END AS "authorType",
        m.position::text AS position,
        m."createdAt" AS "createdAtRaw",
        to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM coordinator_messages m
      JOIN bots b ON b.id = m."botId" AND b."ownerId" = $1 AND b."workspaceId" = $2::uuid
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN jsonb_typeof(m.message->'mikkaDisplay') = 'object'
            AND m.message->'mikkaDisplay'->>'kind' IN ('person', 'reply')
            AND jsonb_typeof(m.message->'mikkaDisplay'->'text') = 'string'
            THEN m.message->'mikkaDisplay'->>'text'
          WHEN jsonb_typeof(m.message->'content') = 'string'
            THEN m.message->>'content'
          WHEN jsonb_typeof(m.message->'content') = 'array'
            THEN (
              SELECT string_agg(p->>'text', E'\\n' ORDER BY ord)
              FROM jsonb_array_elements(m.message->'content') WITH ORDINALITY AS part(p, ord)
              WHERE p->>'type' = 'text'
            )
          ELSE NULL
        END AS body
      ) txt
      WHERE m."userId" = $1
        AND ($6::uuid IS NULL OR m."botId" = $6::uuid)
        AND m.message->>'role' IN ('user', 'assistant')
        AND COALESCE((m.message->>'mikkaSuperseded')::boolean, false) = false
        AND COALESCE((m.message->>'mikkaRetried')::boolean, false) = false
        AND COALESCE(m.message->'mikkaDisplay'->>'kind', '') NOT IN ('hidden', 'event', 'welcome')
        AND txt.body IS NOT NULL
        AND NOT (
          m.message->>'role' = 'user'
          AND m.message->'mikkaDisplay' IS NULL
          AND (
            starts_with(txt.body, $8)
            OR starts_with(txt.body, $9)
            OR (
              COALESCE(m.message->'mikkaUserEvent', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
              AND starts_with(txt.body, '[Event]')
            )
          )
        )
        AND txt.body ILIKE $3 ESCAPE '\\'
        AND ($4::timestamptz IS NULL OR (m."createdAt", m.id) < ($4::timestamptz, $5::uuid))
    `)
  }

  if (includeGroups) {
    branches.push(`
      SELECT
        'group'::text AS kind,
        m.id AS "messageId",
        c.id AS "targetId",
        c.title AS title,
        m.body AS body,
        m."authorType"::text AS "authorType",
        m.position::text AS position,
        m."createdAt" AS "createdAtRaw",
        to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM conversation_messages m
      JOIN conversations c ON c.id = m."conversationId"
        AND c.kind = 'group'
        AND c."workspaceId" = $2::uuid
        AND (c."creationPurpose" <> 'conversation' OR c."createdBy" = $1)
      WHERE ($7::uuid IS NULL OR c.id = $7::uuid)
        AND EXISTS (
          SELECT 1 FROM conversation_members cm
          WHERE cm."conversationId" = c.id
            AND cm."memberType" = 'user'
            AND cm."memberId" = $1
            AND cm."leftAt" IS NULL
        )
        AND m.body ILIKE $3 ESCAPE '\\'
        AND ($4::timestamptz IS NULL OR (m."createdAt", m.id) < ($4::timestamptz, $5::uuid))
    `)
  }

  if (includeThreads) {
    branches.push(`
      SELECT
        'thread'::text AS kind,
        m.id AS "messageId",
        r.id AS "targetId",
        COALESCE(
          NULLIF(btrim(r.title), ''),
          CASE
            WHEN r."promptTaskStart" >= 0 AND r."promptTaskLength" BETWEEN 0 AND length(r.prompt) - r."promptTaskStart"::int8
              THEN left(ltrim(substr(r.prompt, r."promptTaskStart" + 1, r."promptTaskLength"), E' \\t\\r\\n'), 120)
            ELSE left(ltrim(COALESCE(r.prompt, ''), E' \\t\\r\\n'), 120)
          END
        ) AS title,
        m.text AS body,
        CASE WHEN m.origin = 'owner' THEN 'user'::text ELSE 'agent'::text END AS "authorType",
        NULL::text AS position,
        m."createdAt" AS "createdAtRaw",
        to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM run_messages m
      JOIN agent_runs r ON r.id = m."runId"
        AND r."userId" = $1
        AND r."workspaceId" = $2::uuid
        AND r."deletedAt" IS NULL
      WHERE m."userId" = $1
        AND m.text ILIKE $3 ESCAPE '\\'
        AND ($4::timestamptz IS NULL OR (m."createdAt", m.id) < ($4::timestamptz, $5::uuid))
    `)
  }

  if (!branches.length) {
    return { workspaceId: input.workspaceId, query: input.q, items: [], nextCursor: null }
  }

  const sql = `
    SELECT kind, "messageId", "targetId", title, body, "authorType", position, "createdAt"
    FROM (${branches.join('\nUNION ALL\n')}) hits
    ORDER BY "createdAtRaw" DESC, "messageId" DESC
    LIMIT $10
  `

  const { rows } = await pool.query<RawHitRow>(sql, params)
  // Re-verify workspace access after reading so membership revocation never survives a query.
  await requireActiveWorkspaceMember(user, input.workspaceId)

  const page = rows.slice(0, input.limit)
  const last = page.at(-1)
  const items: MobileMessageSearchHit[] = page.map(row => ({
    kind: row.kind,
    messageId: row.messageId,
    targetId: row.targetId,
    title: row.title,
    snippet: buildMessageSearchSnippet(maskCredentials(row.body), input.q),
    authorType: row.authorType,
    position: row.position,
    createdAt: row.createdAt,
  }))

  return {
    workspaceId: input.workspaceId,
    query: input.q,
    items,
    nextCursor:
      rows.length > input.limit && last
        ? encodeMessageSearchCursor(input, { time: last.createdAt, id: last.messageId })
        : null,
  }
}
