import 'server-only'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { escapeLike } from '@/lib/issue-search'
import { maskCredentials } from '@/lib/secrets/mask'
import { COORDINATOR_WELCOME_MARK } from '@/lib/agent-welcome'
import { HANDOFF_PREFIX } from '@/lib/attention/handoff'
import { tokenWorkspace } from '@/lib/tokens/principal'
import type { RequestWorkspaceUser } from '@/lib/request-workspace'
import {
  buildMessageSearchSnippet,
  encodeMessageSearchCursor,
  type MessageSearchInput,
  type MobileMessageSearchHit,
  type MobileMessageSearchPage,
} from './mobile-message-search-contract'

export class MobileMessageSearchAccessError extends Error {}

type SearchUser = RequestWorkspaceUser

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
  if (!(await enterpriseWorkspaceAllowed(user.id, workspaceId, user[enterprisePrincipal]))) {
    throw new MobileMessageSearchAccessError('workspaceAccessDenied')
  }
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
 * `LIMIT`, and workspace membership + enterprise assurance are re-verified
 * before returning results.
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

  if (!includeBots && !includeGroups && !includeThreads) {
    return { workspaceId: input.workspaceId, query: input.q, items: [], nextCursor: null }
  }

  // Bind parameters dynamically as branches are included so PostgreSQL never
  // sees an unreferenced/untyped parameter slot when a scope or filter omits
  // one of the UNION branches.
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }

  const pUser = bind(user.id)
  const pWorkspace = bind(input.workspaceId)
  const pPattern = bind(pattern)
  const pCursorTime = bind(input.cursor?.time ?? null)
  const pCursorId = bind(input.cursor?.id ?? null)

  const branches: string[] = []

  if (includeBots) {
    const pBotId = bind(input.botId)
    const pWelcome = bind(COORDINATOR_WELCOME_MARK)
    const pHandoff = bind(HANDOFF_PREFIX)
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
      JOIN bots b ON b.id = m."botId" AND b."ownerId" = ${pUser} AND b."workspaceId" = ${pWorkspace}::uuid
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
      WHERE m."userId" = ${pUser}
        AND (${pBotId}::uuid IS NULL OR m."botId" = ${pBotId}::uuid)
        AND m.message->>'role' IN ('user', 'assistant')
        AND COALESCE(m.message->'mikkaSuperseded', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb)
        AND COALESCE(m.message->'mikkaRetried', 'false'::jsonb) IS DISTINCT FROM 'true'::jsonb
        AND COALESCE(m.message->'mikkaDisplay'->>'kind', '') NOT IN ('hidden', 'event', 'welcome')
        AND txt.body IS NOT NULL
        AND NOT (
          m.message->>'role' = 'user'
          AND m.message->'mikkaDisplay' IS NULL
          AND (
            starts_with(txt.body, ${pWelcome})
            OR starts_with(txt.body, ${pHandoff})
            OR (
              COALESCE(m.message->'mikkaUserEvent', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
              AND starts_with(txt.body, '[Event]')
            )
          )
        )
        AND txt.body ILIKE ${pPattern} ESCAPE '\\'
        AND (${pCursorTime}::timestamptz IS NULL OR (m."createdAt", m.id) < (${pCursorTime}::timestamptz, ${pCursorId}::uuid))
    `)
  }

  if (includeGroups) {
    const pConversationId = bind(input.conversationId)
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
        AND c."workspaceId" = ${pWorkspace}::uuid
        AND (c."creationPurpose" <> 'conversation' OR c."createdBy" = ${pUser})
      WHERE (${pConversationId}::uuid IS NULL OR c.id = ${pConversationId}::uuid)
        AND EXISTS (
          SELECT 1 FROM conversation_members cm
          WHERE cm."conversationId" = c.id
            AND cm."memberType" = 'user'
            AND cm."memberId" = ${pUser}
            AND cm."leftAt" IS NULL
        )
        AND m.body ILIKE ${pPattern} ESCAPE '\\'
        AND (${pCursorTime}::timestamptz IS NULL OR (m."createdAt", m.id) < (${pCursorTime}::timestamptz, ${pCursorId}::uuid))
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
        AND r."userId" = ${pUser}
        AND r."workspaceId" = ${pWorkspace}::uuid
        AND r."deletedAt" IS NULL
      WHERE m."userId" = ${pUser}
        AND m.text ILIKE ${pPattern} ESCAPE '\\'
        AND (${pCursorTime}::timestamptz IS NULL OR (m."createdAt", m.id) < (${pCursorTime}::timestamptz, ${pCursorId}::uuid))
    `)
  }

  const pLimit = bind(input.limit + 1)
  const sql = `
    SELECT kind, "messageId", "targetId", title, body, "authorType", position, "createdAt"
    FROM (${branches.join('\nUNION ALL\n')}) hits
    ORDER BY "createdAtRaw" DESC, "messageId" DESC
    LIMIT ${pLimit}
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
