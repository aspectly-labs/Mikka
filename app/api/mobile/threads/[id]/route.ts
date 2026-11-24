import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { threadModelProjection } from '@/lib/context-usage'
import { threadReadReceipts } from '@/lib/thread-reads'
import { db, pool } from '@/lib/db'
import { agentRuns, runChunks } from '@/lib/db/schema'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { readRun, readRunMessages } from '@/lib/agent-runs'
import { readRunChain } from '@/lib/run-chain'
import { sendThreadMessage } from '@/lib/thread-continue'
import { ActionFailureError } from '@/lib/action-error'
import { chainChunks, runIsActive, runIsWorking, threadItems } from '@/lib/issue-run-conversation'
import { isThreadRun } from '@/lib/issue-threads'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { parseThreadPageParams, sliceThreadItemsPage } from '@/lib/mobile-thread-pagination'
import { mobileThread } from '@/lib/mobile-threads'
import { runOutsideToken } from '@/lib/tokens/scope'
import { threadQuotaView } from '@/lib/run-quota-view'
import { threadLiveReferences } from '@/lib/live/panels'
import { workspacePool } from '@/lib/workspace-db'


type Params = { params: Promise<{ id: string }> }

/**
 * `GET /api/mobile/threads/:id`: one thread as a conversation: agent replies, folded steps, what the person said.
 * Optional `?limit=<1..100>&before=<historyBefore>` pages older thread items backwards while keeping legacy full reads unchanged when omitted.
 */
async function handleGET(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const page = parseThreadPageParams(new URL(request.url).searchParams)
  if (!page) return json({ error: 'invalidWindow' }, 400)
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  const [thread, detail] = await Promise.all([mobileThread(user.id, id.data), readRun(user.id, id.data)])
  if (!thread || !detail) return json({ error: 'runNotFound' }, 404)
  // readRun checked access. The thread is its runs from this one on (R-81: an ended thread runs again in it);
  // the chunks are read with their times so people's messages fall in between.
  const chain = detail.run.agentId ? await readRunChain(pool, user.id, detail.run.id) : null
  const from = chain ? Math.max(0, chain.attempts.findIndex(attempt => attempt.runId === detail.run.id)) : 0
  const runIds = chain ? chain.attempts.slice(from).map(attempt => attempt.runId) : [detail.run.id]
  const live = chain?.attempts.find(attempt => attempt.runId === chain.latestRunId)?.status ?? detail.run.status
  const readReceipts = detail.run.agentId ? await threadReadReceipts(user.id, runIds) : []
  const rawChunks = await db.select({ runId: runChunks.runId, seq: runChunks.seq, chunk: runChunks.chunk, at: runChunks.createdAt }).from(runChunks)
    .innerJoin(agentRuns, eq(agentRuns.id, runChunks.runId))
    .where(inArray(runChunks.runId, runIds)).orderBy(asc(agentRuns.createdAt), asc(runChunks.seq))
  const chunks = chainChunks(rawChunks)
  const messages = runIds.length > 1 ? await readRunMessages(user.id, runIds) : detail.messages
  const allItems = await threadItems(
    detail.run.agentId ? chunks : [],
    messages.map(message => ({ id: message.id, text: message.text, author: user.name, mine: true, at: message.createdAt })),
  )
  const paged = sliceThreadItemsPage(allItems, page)
  const items = paged.items
  // A run paused on its subscription's quota: when it resets and whether a key can take over (the web's ThreadQuotaPausedCard).
  const liveRunId = chain?.latestRunId ?? detail.run.id
  const [model, { paused }, runs, delivery, control] = await Promise.all([
    pool.query<{ selectedModel: string | null; servedModel: string | null }>(
      `SELECT ${threadModelProjection} FROM agent_runs latest WHERE latest.id=$1 AND latest."userId"=$2`, [liveRunId, user.id]),
    live === 'paused' ? threadQuotaView(user.id, [liveRunId], liveRunId) : { paused: null },
    // Where each run's thread and run keys arrive (the web's thread panel listens to the same).
    threadLiveReferences(pool, workspacePool, runIds, user.id),
    chain ? (await import('@/lib/thread-delivery-queue')).threadDeliveryView(pool, user.id, chain.rootRunId, liveRunId) : undefined,
    pool.query<{ independentCheck: boolean; subagent: boolean; kind: string | null; threadRelation: string | null }>(
      `SELECT EXISTS (SELECT 1 FROM factory_attempts a WHERE a."runId"=r.id AND a.stage IN ('review','verify','monitor')) AS "independentCheck",
        (r."threadRelation"='subagent' OR EXISTS (SELECT 1 FROM agent_runs root WHERE root.id=$3 AND root."userId"=$2 AND root."threadRelation"='subagent')) AS subagent,
        r.kind, coalesce(r."threadRelation", (SELECT root."threadRelation" FROM agent_runs root WHERE root.id=$3 AND root."userId"=$2)) AS "threadRelation"
       FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2`, [liveRunId, user.id, chain?.rootRunId ?? liveRunId]),
  ])
  const readOnlyForHuman = Boolean(control.rows[0]?.independentCheck || control.rows[0]?.subagent || (control.rows[0]?.kind && !isThreadRun({ kind: control.rows[0].kind })))
  const sourceRuns=[...new Set(rawChunks.map(row=>row.runId))]
  const versionAnchors=readOnlyForHuman ? {} : Object.fromEntries(items.flatMap(item => {
    if (!chain || !detail.run.issueId) return []
    if (item.kind==='person') {
      const source=messages.find(row=>row.id===item.id && row.editable)
      return source?.sourceRunId ? [[item.id,{runId:source.sourceRunId,key:item.id,operation:'edit'}]] : []
    }
    if (item.kind!=='agent') return []
    // Every chunk id is scoped to its run (chainChunks): the anchor is the run and the id the run gave the text.
    const part=item.id.slice('text:'.length)
    const source=sourceRuns.find(id=>part.startsWith(id+':'))
    return source ? [[item.id,{runId:source,key:part.slice(source.length+1),operation:'rerun'}]] : []
  }))
  return json({ liveRunId, composerModel: model.rows[0] ?? null, readReceipts, versionAnchors, delivery, issueId: detail.run.issueId, threadRelation: control.rows[0]?.threadRelation ?? null, canReply: Boolean(detail.run.agentId) && !readOnlyForHuman, confirmedSubmissionIds: messages.flatMap(message => message.submissionId ? [message.submissionId] : []), live: { runs }, thread, active: runIsActive(live), working: runIsWorking(live), paused, summary: detail.run.report && typeof detail.run.report.summary === 'string' ? detail.run.report.summary : null, error: detail.run.error, items, historyBefore: paged.historyBefore, hasMore: paged.hasMore, totalItems: paged.totalItems })
}

/** `POST /api/mobile/threads/:id` with `{ text }`: a message to the thread; the daemon delivers it, or an ended thread runs again. */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.object({ text: z.string().trim().min(1).max(10_000) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'messageRequired' }, 400)
  const id = (await params).id
  if (z.uuid().safeParse(id).success && await runOutsideToken(user, id)) return json({ error: 'runNotFound' }, 404)
  if (z.uuid().safeParse(id).success) {
    const chain = await readRunChain(pool, user.id, id)
    const targetRunId = chain?.latestRunId ?? id
    const rootRunId = chain?.rootRunId ?? targetRunId
    const { rows: [target] } = await pool.query<{ independentCheck: boolean; subagent: boolean; kind: string | null }>(
      `SELECT EXISTS (SELECT 1 FROM factory_attempts a WHERE a."runId"=r.id AND a.stage IN ('review','verify','monitor')) AS "independentCheck",
        (r."threadRelation"='subagent' OR EXISTS (SELECT 1 FROM agent_runs root WHERE root.id=$3 AND root."userId"=$2 AND root."threadRelation"='subagent')) AS subagent,
        r.kind FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2`, [targetRunId, user.id, rootRunId])
    if (target && (target.independentCheck || target.subagent || (target.kind && !isThreadRun({ kind: target.kind })))) {
      return json({ error: 'threadCannotContinue' }, 400)
    }
  }
  try {
    // A working thread gets it as a message; an ended one runs again in the same thread (R-81).
    await sendThreadMessage(user.id, id, body.data.text)
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 400)
    throw error
  }
  return json({ queued: true }, 202)
}

export const GET = withRequestLog('/api/mobile/threads/[id]', handleGET)
export const POST = withRequestLog('/api/mobile/threads/[id]', handlePOST)
