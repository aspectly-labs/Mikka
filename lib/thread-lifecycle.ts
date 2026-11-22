import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { readRunChain } from '@/lib/run-chain'
import { runOutsideToken } from '@/lib/tokens/scope'
import { ScheduleStore } from '@/lib/schedules/store'
import type { RequestWorkspaceUser } from '@/lib/request-workspace'

// #2936 thread lifecycle. A "thread" is its run chain rooted at the root run:
// every relation column (`parentRunId`, `threadRelation`) anchors to that root so
// forks, side threads and subagents read as one tree, and soft-delete/patch tags
// live on the root the lists render.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARE_PREFIX = 'mkt_'
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const THREAD_RECOVERY_DAYS = 30

type ApiUser = RequestWorkspaceUser
type Run = Record<string, any>

export function isRunId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }

/** The run only its owner may touch, inside their token's pinned workspace. */
async function ownedRun(user: ApiUser, runId: string, { includeDeleted = false } = {}): Promise<Run | null> {
  if (!isRunId(runId)) return null
  const { rows: [run] } = await pool.query(
    `SELECT * FROM agent_runs WHERE id=$1${includeDeleted ? '' : ` AND "deletedAt" IS NULL`}`, [runId])
  if (!run || run.userId !== user.id) return null
  if (await runOutsideToken(user, runId)) return null
  return run
}

async function rootRunId(user: ApiUser, runId: string): Promise<string | null> {
  const chain = await readRunChain(pool, user.id, runId)
  return chain ? String(chain.rootRunId) : null
}

const RUN_COPY_COLUMNS = `"userId","issueId","agentId","deviceId","deviceRepoId","workspaceId","botId","agentDefinition",kind,"baseBranch","machineAuthority",source`

export type ThreadRelation = 'fork' | 'side' | 'subagent'

async function transcriptExcerpt(sourceRootId: string, limit = 20): Promise<string> {
  const { rows } = await pool.query(
    `SELECT text FROM run_messages WHERE "runId" IN (SELECT id FROM agent_runs WHERE id=$1 OR "continuesRunId"=$1 OR "retryOf"=$1) ORDER BY "createdAt" DESC LIMIT $2`,
    [sourceRootId, limit])
  return rows.reverse().map(row => String(row.text)).join('\n')
}

/** Spawn a child thread off a run. `fork` seeds the prompt with the transcript
 * (full) or a condensed excerpt (summary); `side` anchors to one message and
 * keeps the excerpt small. Either way the child is queued to run. */
export async function spawnThread(user: ApiUser, runId: string, input: {
  relation: Exclude<ThreadRelation, 'subagent'>, mode?: 'full' | 'summary', fromMessageId?: string | null,
}): Promise<Run | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const relation = input.relation
  if (input.fromMessageId) {
    const { rows: [message] } = await pool.query(`SELECT id FROM run_messages WHERE id=$1 AND "runId" IN (SELECT id FROM agent_runs WHERE id=$2 OR "continuesRunId"=$2 OR "retryOf"=$2)`, [input.fromMessageId, root])
    if (!message) return null
  }
  const prompt = relation === 'fork' && input.mode !== 'summary'
    ? source.prompt
    : `Thread forked from "${source.title ?? 'untitled thread'}"${relation === 'side' && input.fromMessageId ? ' at a message' : ''}:\n\n${(await transcriptExcerpt(root, relation === 'side' ? 5 : 20)).slice(0, 6000)}`
  const id = randomUUID()
  const { rows: [run] } = await pool.query(
    `INSERT INTO agent_runs (id,${RUN_COPY_COLUMNS},status,prompt,"parentRunId","threadRelation","sourceMessageId","startedAt","leaseExpiresAt",origin)
     SELECT $1,${RUN_COPY_COLUMNS},'queued',$3,$4,$5,$6,now(),now()+interval '60 seconds','web' FROM agent_runs WHERE id=$2 RETURNING *`,
    [id, root, prompt, root, relation, input.fromMessageId ?? null])
  if (!run) return null
  // A full fork replays the transcript up to `fromMessageId` (or all of it);
  // the owner keeps their run_messages as the copied conversation state.
  if (relation === 'fork' && input.mode !== 'summary') {
    await pool.query(
      `INSERT INTO run_messages(id,"runId","userId",text,origin,"mailboxWakeDepth","deliveredAt","createdAt")
       SELECT gen_random_uuid(),$1,"userId",text,origin,"mailboxWakeDepth","deliveredAt","createdAt" FROM run_messages
       WHERE "runId" IN (SELECT id FROM agent_runs WHERE id=$2 OR "continuesRunId"=$2 OR "retryOf"=$2)
         AND ($3::uuid IS NULL OR "createdAt" <= (SELECT "createdAt" FROM run_messages WHERE id=$3))
       ORDER BY "createdAt"`,
      [id, root, input.fromMessageId ?? null])
  }
  return run
}

/** The direct children of a thread (forks, side threads, subagents). */
export async function listThreadChildren(user: ApiUser, runId: string): Promise<Run[] | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const { rows } = await pool.query(
    `SELECT id,"threadRelation",kind,status,outcome,title,"sourceMessageId","createdAt" FROM agent_runs WHERE "parentRunId"=$1 AND "deletedAt" IS NULL ORDER BY "createdAt"`, [root])
  return rows
}

/** A read-only share link for the thread's transcript; revoking ends it. */
export async function createThreadShare(user: ApiUser, runId: string): Promise<{ shareId: string; token: string } | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const token = `${SHARE_PREFIX}${randomBytes(24).toString('base64url')}`
  const shareId = randomUUID()
  await pool.query(`INSERT INTO run_thread_shares(id,"runId","tokenHash","createdBy") VALUES($1,$2,$3,$4)`, [shareId, root, hashToken(token), user.id])
  return { shareId, token }
}

export async function revokeThreadShares(user: ApiUser, runId: string): Promise<number | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const { rowCount } = await pool.query(`UPDATE run_thread_shares SET "revokedAt"=now() WHERE "runId"=$1 AND "createdBy"=$2 AND "revokedAt" IS NULL`, [root, user.id])
  return rowCount ?? 0
}

/** Anyone holding a live token reads a small transcript projection — nothing to reply to. */
export async function sharedThread(token: string): Promise<Run | null> {
  if (typeof token !== 'string' || !token.startsWith(SHARE_PREFIX)) return null
  const { rows: [run] } = await pool.query(
    `SELECT r.id,r.title,r.status,r.outcome,r."lastReply",r."lastReplyAt",r."createdAt",r."updatedAt" FROM run_thread_shares s
     JOIN agent_runs r ON r.id=s."runId" WHERE s."tokenHash"=$1 AND s."revokedAt" IS NULL AND r."deletedAt" IS NULL`, [hashToken(token)])
  if (!run) return null
  const { rows: messages } = await pool.query(
    `SELECT id,text,origin,"createdAt" FROM run_messages WHERE "runId" IN (SELECT id FROM agent_runs WHERE id=$1 OR "continuesRunId"=$1 OR "retryOf"=$1) ORDER BY "createdAt" LIMIT 200`, [run.id])
  return { ...run, messages }
}

/** PATCH: retarget the thread's task and/or its tags (on the root the lists read). */
export async function patchThread(user: ApiUser, runId: string, input: { taskId?: string | null, tags?: string[] }): Promise<Run | null | 'forbidden'> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  if (input.taskId !== undefined && input.taskId !== null) {
    if (!isRunId(input.taskId)) return null
    const { rows: [issue] } = await pool.query(`SELECT id,"userId","workspaceId" FROM issues WHERE id=$1`, [input.taskId])
    if (!issue || (issue.userId !== user.id && issue.workspaceId !== source.workspaceId)) return 'forbidden'
  }
  const sets: string[] = [], params: unknown[] = [root]
  if (input.taskId !== undefined) { params.push(input.taskId); sets.push(`"issueId"=$${params.length}`) }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(tag => typeof tag !== 'string' || tag.length > 60)) return null
    params.push(JSON.stringify(input.tags)); sets.push(`tags=$${params.length}::jsonb`)
  }
  if (!sets.length) return source
  const { rows: [run] } = await pool.query(`UPDATE agent_runs SET ${sets.join(',')} WHERE id=$1 RETURNING *`, params)
  return run ?? null
}

/** Soft-delete: gone from every list for RECOVERY_DAYS days, then permanent. */
export async function deleteThread(user: ApiUser, runId: string): Promise<boolean | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const { rowCount } = await pool.query(`UPDATE agent_runs SET "deletedAt"=now(),"deletedBy"=$2 WHERE id=$1 AND "deletedAt" IS NULL`, [root, user.id])
  return Boolean(rowCount)
}

export async function restoreThread(user: ApiUser, runId: string): Promise<boolean | null> {
  const source = await ownedRun(user, runId, { includeDeleted: true })
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const { rowCount } = await pool.query(
    `UPDATE agent_runs SET "deletedAt"=NULL,"deletedBy"=NULL WHERE id=$1 AND "deletedAt" > now() - interval '1 day' * ${THREAD_RECOVERY_DAYS}`, [root])
  return Boolean(rowCount)
}

/** Bind a Slack thread (slack_thread_bots row) to this thread so its replies route here. */
export async function bindSlackThread(user: ApiUser, runId: string, input: { linkId: string, channelId: string, threadTs: string }): Promise<boolean | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root || !isRunId(input.linkId) || !input.channelId || !input.threadTs) return null
  const { rowCount } = await pool.query(
    `UPDATE slack_thread_bots SET "boundRunId"=$4 WHERE "linkId"=$1 AND "channelId"=$2 AND "threadTs"=$3 AND "ownerId"=$5`,
    [input.linkId, input.channelId, input.threadTs, root, user.id])
  return Boolean(rowCount)
}

/** Thread → automation: a schedule that dispatches every run into this thread (eachRun: existing_thread). */
export async function threadToAutomation(user: ApiUser, runId: string, definition: Record<string, unknown>): Promise<Record<string, unknown> | null | 'forbidden'> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const store = new ScheduleStore()
  const result = await store.command({ ownerId: user.id, workspaceId: source.workspaceId ?? null, botId: source.botId ?? null, direct: true },
    { action: 'create', requestId: randomUUID(), definition })
  const schedule = (result as { schedule?: { id: string } })?.schedule
  if (!schedule) return 'forbidden'
  await pool.query(`UPDATE user_schedules SET source_run_id=$1 WHERE id=$2`, [root, schedule.id])
  return result as Record<string, unknown>
}

/** Move the thread between the cloud and one of the owner's devices. */
export async function moveThread(user: ApiUser, runId: string, target: { deviceId: string | 'cloud' }): Promise<boolean | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  if (target.deviceId === 'cloud') {
    await pool.query(`UPDATE agent_runs SET "deviceId"=NULL,"deviceRepoId"=NULL,"machineAuthority"=true WHERE id=$1`, [root])
    return true
  }
  if (!isRunId(target.deviceId)) return null
  const { rows: [device] } = await pool.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2`, [target.deviceId, user.id])
  if (!device) return null
  await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"machineAuthority"=false WHERE id=$1`, [root, target.deviceId])
  return true
}
