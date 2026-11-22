import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '../action-error'
import { MESSAGE_MAX } from '../message-limits'
import { splitQuote } from '../artifacts/quote'
import { splitBrowserNotes } from '../browser/note'
import { splitSuggestion } from '../suggestions/card'

/**
 * Edit and Regenerate in a Bot chat (decision 2026-11-22-1700): a revision takes the chat's latest turn, the person's
 * last message and the reply after it, out of the chat and out of the Bot's model history, and the same or the edited
 * words go again. The turn's rows stay stored, marked `mikkaSuperseded` with the revision's id, so the earlier version
 * reads back (‹ 1/2 ›). Only a turn with nothing but words can be revised: a tool call, a dispatched thread or a created
 * task happened in the world and would not be undone, so a turn that has one is refused.
 */
export const revisionInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('edit'), position: z.number().int().positive(), requestId: z.uuid(), text: z.string().trim().min(1).max(MESSAGE_MAX) }).strict(),
  z.object({ operation: z.literal('regenerate'), position: z.number().int().positive(), requestId: z.uuid() }).strict(),
])
export type RevisionInput = z.infer<typeof revisionInput>

/** What goes to the Bot again: the person's words and the images their message carried. */
export interface RevisionSend { id: string; submissionId: string; text: string; images: { dataUrl: string; mediaType: string }[]; cleared: boolean }

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }
type Row = { id: string; position: number; message: Record<string, unknown> }
type Revision = { id: string; botId: string; operation: string; fromPosition: number; throughPosition: number; submissionId: string; clearedAt: string | null; slot: string }

const chatLock = (userId: string, botId: string) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-chat:${userId}:${botId}`},0))`

/** A UUID a revision's message is sent under, the same for every retry of the same revision. */
export function revisionSubmissionId(revisionId: string) {
  const bytes = createHash('sha256').update(JSON.stringify(['mikka-bot-chat-revision', revisionId])).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function revisionId(userId: string, requestId: string) {
  const bytes = createHash('sha256').update(JSON.stringify(['mikka-bot-chat-revision-request', userId, requestId.toLowerCase()])).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const toolFree = (row: Row) => row.message.role === 'assistant' && !row.message.mikkaEvent && !row.message.mikkaScheduleResult
  && (typeof row.message.content === 'string' || Array.isArray(row.message.content) && row.message.content.every(part => part && typeof part === 'object' && ['text', 'reasoning'].includes(String((part as { type?: unknown }).type))))

/** The latest turn: the person's last message in the chat and every row after it, when it can be revised at all. */
async function latestTurn(tx: Executor, userId: string, botId: string) {
  const rows = (await tx.execute(sql`SELECT id,position,message FROM coordinator_messages
    WHERE "userId"=${userId} AND "botId"=${botId}::uuid AND NOT message ? 'mikkaSuperseded' AND position >= coalesce((
      SELECT max(position) FROM coordinator_messages WHERE "userId"=${userId} AND "botId"=${botId}::uuid
        AND message->>'role'='user' AND NOT message ? 'mikkaSuperseded'), 2147483647)
    ORDER BY position`)).rows as Row[]
  const [anchor, ...rest] = rows
  if (!anchor || anchor.message.role !== 'user' || anchor.message.mikkaRetried === true) return null
  const source = anchor.message.mikkaUserEvent as { id?: unknown; submissionId?: unknown } | undefined
  if (typeof source?.id !== 'string' || typeof source.submissionId !== 'string') return null
  const [event] = (await tx.execute(sql`SELECT payload FROM coordinator_events WHERE id::text=${source.id} AND "userId"=${userId}
    AND "botId"=${botId}::uuid AND kind='user_message'`)).rows as { payload: Record<string, unknown> }[]
  const payload = event?.payload
  // Only the person's own words: a task request, a schedule's or a welcome's message is not theirs to rewrite here.
  if (!payload || payload.source !== 'person' || payload.taskCommand || payload.taskDestination || payload.profileId || payload.taskTitle
    || payload.schedule || typeof payload.text !== 'string') return null
  if (!rest.every(toolFree)) return null
  return { anchor, rest, payload: payload as { text: string; images?: unknown }, submissionId: source.submissionId }
}

/**
 * Takes the latest turn out of the chat for `input` and records the revision, in one transaction under the chat's
 * lock. The same `requestId` again returns the revision already made, so a retried click sends nothing twice.
 */
export async function beginRevision(db: { transaction: <T>(run: (tx: Executor) => Promise<T>) => Promise<T> }, scope: { userId: string; botId: string; workspaceId: string },
  raw: RevisionInput, changed: (tx: Executor) => Promise<void>): Promise<RevisionSend> {
  const input = revisionInput.parse(raw)
  const id = revisionId(scope.userId, input.requestId)
  return db.transaction(async tx => {
    await tx.execute(chatLock(scope.userId, scope.botId))
    const [known] = (await tx.execute(sql`SELECT id,"botId",operation,"fromPosition","throughPosition","submissionId","clearedAt",slot
      FROM bot_chat_revisions WHERE id=${id}::uuid AND "userId"=${scope.userId}`)).rows as Revision[]
    if (known) {
      if (known.botId !== scope.botId || known.operation !== input.operation) throw new ActionFailureError('submissionConflict')
      const rows = (await tx.execute(sql`SELECT id,position,message FROM coordinator_messages WHERE "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid
        AND message->>'mikkaSuperseded'=${id} ORDER BY position LIMIT 1`)).rows as Row[]
      const event = rows[0] && await anchorPayload(tx, scope, rows[0])
      if (!event) throw new ActionFailureError('chatRevisionUnavailable')
      return { id, submissionId: known.submissionId, text: input.operation === 'edit' ? input.text : event.text, images: images(event.images), cleared: known.clearedAt !== null }
    }
    // A message waiting for the Bot (sent while it worked, or a host event) would be answered in the middle of a rewrite.
    const waiting = (await tx.execute(sql`SELECT 1 FROM coordinator_events WHERE "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid AND "deliveredAt" IS NULL LIMIT 1`)).rows
    if (waiting.length) throw new ActionFailureError('chatRevisionBusy')
    const turn = await latestTurn(tx, scope.userId, scope.botId)
    if (!turn) throw new ActionFailureError('chatRevisionUnavailable')
    if (input.operation === 'edit' && input.position !== turn.anchor.position) throw new ActionFailureError('chatRevisionUnavailable')
    if (input.operation === 'regenerate' && !turn.rest.some(row => row.position === input.position && row.message.role === 'assistant')) throw new ActionFailureError('chatRevisionUnavailable')
    // An artifact quote or browser notes ride in the stored text; the edit box shows only the words, so it cannot keep them.
    if (input.operation === 'edit' && (splitQuote(turn.payload.text).quote || splitBrowserNotes(turn.payload.text).notes.length || splitSuggestion(turn.payload.text).suggestion)) throw new ActionFailureError('chatRevisionUnavailable')
    const [prior] = (await tx.execute(sql`SELECT slot FROM bot_chat_revisions WHERE "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid
      AND "submissionId"=${turn.submissionId}::uuid ORDER BY "createdAt" DESC LIMIT 1`)).rows as { slot: string }[]
    const through = turn.rest.at(-1)?.position ?? turn.anchor.position
    const submissionId = revisionSubmissionId(id)
    await tx.execute(sql`INSERT INTO bot_chat_revisions (id,"userId","botId","workspaceId","requestId",operation,slot,"fromPosition","throughPosition","submissionId")
      VALUES (${id}::uuid,${scope.userId},${scope.botId}::uuid,${scope.workspaceId}::uuid,${input.requestId}::uuid,${input.operation},${prior?.slot ?? id}::uuid,${turn.anchor.position},${through},${submissionId}::uuid)`)
    await tx.execute(sql`UPDATE coordinator_messages SET message = message || jsonb_build_object('mikkaSuperseded', ${id}::text)
      WHERE "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid AND position BETWEEN ${turn.anchor.position} AND ${through} AND NOT message ? 'mikkaSuperseded'`)
    await changed(tx)
    return { id, submissionId, text: input.operation === 'edit' ? input.text : turn.payload.text, images: images(turn.payload.images), cleared: false }
  })
}

async function anchorPayload(tx: Executor, scope: { userId: string; botId: string }, row: Row) {
  const source = row.message.mikkaUserEvent as { id?: unknown } | undefined
  if (typeof source?.id !== 'string') return null
  const [event] = (await tx.execute(sql`SELECT payload FROM coordinator_events WHERE id::text=${source.id} AND "userId"=${scope.userId}
    AND "botId"=${scope.botId}::uuid AND kind='user_message'`)).rows as { payload: { text?: unknown; images?: unknown } }[]
  return event && typeof event.payload.text === 'string' ? { text: event.payload.text, images: event.payload.images } : null
}

function images(value: unknown) {
  return Array.isArray(value) ? value.flatMap(image => image && typeof image === 'object' && typeof (image as { dataUrl?: unknown }).dataUrl === 'string'
    && typeof (image as { mediaType?: unknown }).mediaType === 'string' ? [{ dataUrl: (image as { dataUrl: string }).dataUrl, mediaType: (image as { mediaType: string }).mediaType }] : []) : []
}

/** Puts the turn back when eve could not clear the Bot's history: nothing changed for the Bot, so the chat must not either. */
export async function abandonRevision(db: { transaction: <T>(run: (tx: Executor) => Promise<T>) => Promise<T> }, scope: { userId: string; botId: string }, id: string, changed: (tx: Executor) => Promise<void>) {
  await db.transaction(async tx => {
    await tx.execute(chatLock(scope.userId, scope.botId))
    const removed = (await tx.execute(sql`DELETE FROM bot_chat_revisions WHERE id=${id}::uuid AND "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid AND "clearedAt" IS NULL RETURNING id`)).rows
    if (!removed.length) return
    await tx.execute(sql`UPDATE coordinator_messages SET message = message - 'mikkaSuperseded'
      WHERE "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid AND message->>'mikkaSuperseded'=${id}`)
    await changed(tx)
  })
}

/** eve has cleared the Bot's model history: the next message must carry the chat's remaining history back. */
export async function revisionCleared(db: Executor, scope: { userId: string; botId: string }, id: string) {
  await db.execute(sql`UPDATE bot_chat_revisions SET "clearedAt"=coalesce("clearedAt",now()) WHERE id=${id}::uuid AND "userId"=${scope.userId} AND "botId"=${scope.botId}::uuid`)
}

/**
 * Whether the message eve is about to take is the first since a revision cleared the Bot's history. Claims that once:
 * the caller then gives eve the chat's remaining history with it (lib/eve/history.ts).
 */
export async function claimRevisionImport(pool: { query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> }, scope: { userId: string; botId: string }): Promise<boolean> {
  return (await pool.query(`UPDATE bot_chat_revisions SET "importedAt"=now() WHERE "userId"=$1 AND "botId"=$2::uuid
    AND "clearedAt" IS NOT NULL AND "importedAt" IS NULL RETURNING id`, [scope.userId, scope.botId])).rows.length > 0
}

export interface TurnVersion { person: string; reply: string; at: string }

/**
 * The earlier versions of each revised turn still in the chat, by the submission id of the person's message that now
 * stands for it, oldest first. A version is what the chat showed then: the person's words and the reply's words.
 */
export async function readTurnVersions(db: Executor, userId: string, botId: string): Promise<Record<string, TurnVersion[]>> {
  const rows = (await db.execute(sql`WITH latest AS (
      SELECT DISTINCT ON (slot) slot,"submissionId" FROM bot_chat_revisions WHERE "userId"=${userId} AND "botId"=${botId}::uuid ORDER BY slot,"createdAt" DESC)
    SELECT latest."submissionId" AS "current", r.id, r."createdAt", m.position, m.message
    FROM latest JOIN bot_chat_revisions r ON r.slot=latest.slot AND r."userId"=${userId} AND r."botId"=${botId}::uuid
    JOIN coordinator_messages m ON m."userId"=${userId} AND m."botId"=${botId}::uuid AND m.message->>'mikkaSuperseded'=r.id::text
    ORDER BY r."createdAt", m.position`)).rows as { current: string; id: string; createdAt: string; position: number; message: Record<string, unknown> }[]
  const out: Record<string, TurnVersion[]> = {}
  const byRevision = new Map<string, TurnVersion>()
  for (const row of rows) {
    let version = byRevision.get(row.id)
    if (!version) {
      version = { person: '', reply: '', at: new Date(row.createdAt).toISOString() }
      byRevision.set(row.id, version)
      ;(out[row.current] ??= []).push(version)
    }
    const words = textOf(row.message)
    if (row.message.role === 'user') version.person = splitBrowserNotes(splitQuote(words).text).text
    else if (row.message.role === 'assistant' && words) version.reply = version.reply ? `${version.reply}\n\n${words}` : words
  }
  return out
}

function textOf(message: Record<string, unknown>) {
  const content = message.content
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.flatMap(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n')
    : ''
}
