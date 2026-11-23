import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { readRunChain } from '@/lib/run-chain'
import { runOutsideToken } from '@/lib/tokens/scope'
import { runListChanged } from '@/lib/live/lists'
import { runChanged } from '@/lib/live/panels'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { schedules } from '@/lib/schedules/runtime'
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

/** The run only its owner may touch, inside their token's pinned workspace and a bound Task — revoked Task access ends lifecycle writes too. */
async function ownedRun(user: ApiUser, runId: string, { includeDeleted = false } = {}): Promise<Run | null> {
  if (!isRunId(runId)) return null
  const { rows: [run] } = await pool.query(
    `SELECT * FROM agent_runs WHERE id=$1${includeDeleted ? '' : ` AND "deletedAt" IS NULL`}
       AND ("issueId" IS NULL OR EXISTS (SELECT 1 FROM issues i WHERE i.id=agent_runs."issueId" AND i."workspaceId"=agent_runs."workspaceId" AND i."ownershipState"='bound'))`, [runId])
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

/** Every run id of the thread rooted at $1 (the root plus all continuations). */
const CHAIN_SQL = `WITH RECURSIVE chain AS (SELECT id FROM agent_runs WHERE id=$1
  UNION ALL SELECT r.id FROM agent_runs r JOIN chain ON r."continuesRunId"=chain.id OR r."retryOf"=chain.id)`

async function transcriptExcerpt(sourceRootId: string, limit = 20, cutoff?: string | null): Promise<string> {
  const { rows } = await pool.query(
    `${CHAIN_SQL} SELECT text FROM run_messages WHERE "runId" IN (SELECT id FROM chain) AND ($3::timestamptz IS NULL OR "createdAt" <= $3) ORDER BY "createdAt" DESC LIMIT $2`,
    [sourceRootId, limit, cutoff ?? null])
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
  // `fromMessageId` is the branch point: nothing after it joins the copy or the prompt.
  let cutoff: string | null = null
  if (input.fromMessageId) {
    const { rows: [message] } = await pool.query(`${CHAIN_SQL} SELECT id,"createdAt"::text AS at FROM run_messages WHERE id=$2 AND "runId" IN (SELECT id FROM chain)`, [root, input.fromMessageId])
    if (!message) return null
    cutoff = message.at
  }
  // A full replay also carries the person's follow-up inputs, not just the first prompt.
  const replay = relation === 'fork' && input.mode !== 'summary' ? (await transcriptExcerpt(root, 50, cutoff)).slice(0, 8000) : ''
  const prompt = relation === 'fork' && input.mode !== 'summary'
    ? `${source.prompt}${replay ? `\n\n${replay}` : ''}`
    : `Thread forked from "${source.title ?? 'untitled thread'}"${relation === 'side' && input.fromMessageId ? ' at a message' : ''}:\n\n${(await transcriptExcerpt(root, relation === 'side' ? 5 : 20, cutoff)).slice(0, 6000)}`
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
      `${CHAIN_SQL} INSERT INTO run_messages(id,"runId","userId",text,origin,"mailboxWakeDepth","deliveredAt","createdAt")
       SELECT gen_random_uuid(),$2,"userId",text,origin,"mailboxWakeDepth","deliveredAt","createdAt" FROM run_messages
       WHERE "runId" IN (SELECT id FROM chain)
         AND ($3::timestamptz IS NULL OR "createdAt" <= $3)
       ORDER BY "createdAt"`,
      [root, id, cutoff])
    // The agent's own answers and tool calls live in the chunk stream; copy it
    // too. Negative seqs keep history ordered without colliding with the
    // sequence numbers the child's own writer assigns (onConflictDoNothing
    // would silently drop new replies at copied seqs). `cutoff` bounds history
    // at the selected message.
    await pool.query(
      `${CHAIN_SQL} INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt")
       SELECT gen_random_uuid(),$2,-ROW_NUMBER() OVER (ORDER BY "createdAt" DESC,seq DESC),chunk,"createdAt" FROM run_chunks
       WHERE "runId" IN (SELECT id FROM chain) AND ($3::timestamptz IS NULL OR "createdAt" <= $3) ORDER BY "createdAt",seq`,
      [root, id, cutoff])
  }
  // Wake the child's execution: a device run pings its device; a cloud run gets a machine claim.
  if (run.deviceId) notifyDeviceWork(String(run.deviceId))
  else if (run.workspaceId) {
    const { startThreadMachine } = await import('@/lib/run-leases')
    await startThreadMachine({ userId: user.id, workspaceId: String(run.workspaceId) }, String(run.id)).catch(() => undefined)
  }
  await runListChanged(pool, String(run.id)); await runChanged(pool, String(run.id))
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
    `${CHAIN_SQL} SELECT id,text,origin,"createdAt" FROM run_messages WHERE "runId" IN (SELECT id FROM chain) ORDER BY "createdAt" LIMIT 200`, [run.id])
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
  // Task retarget spans the whole chain — continuations join on "issueId", so a
  // root-only move would split the thread. Tags live on the root the lists read.
  if (input.taskId !== undefined)
    await pool.query(`${CHAIN_SQL} UPDATE agent_runs SET "issueId"=$2 WHERE id IN (SELECT id FROM chain)`, [root, input.taskId])
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(tag => typeof tag !== 'string' || tag.length > 60)) return null
    await pool.query(`UPDATE agent_runs SET tags=$2::jsonb WHERE id=$1`, [root, JSON.stringify(input.tags)])
  }
  if (input.taskId === undefined && input.tags === undefined) return source
  await runListChanged(pool, root); await runChanged(pool, root)
  const { rows: [run] } = await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [root])
  return run ?? null
}

/** Soft-delete: gone from every list for RECOVERY_DAYS days, then permanent. */
export async function deleteThread(user: ApiUser, runId: string): Promise<boolean | null> {
  const source = await ownedRun(user, runId)
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  // Deleting marks the whole chain, so no continuation stays dispatchable.
  const { rowCount } = await pool.query(
    `${CHAIN_SQL} UPDATE agent_runs SET "deletedAt"=now(),"deletedBy"=$2 WHERE id IN (SELECT id FROM chain) AND "deletedAt" IS NULL`, [root, user.id])
  await runListChanged(pool, root); await runChanged(pool, root)
  return Boolean(rowCount)
}

export async function restoreThread(user: ApiUser, runId: string): Promise<boolean | null> {
  const source = await ownedRun(user, runId, { includeDeleted: true })
  if (!source) return null
  const root = await rootRunId(user, runId)
  if (!root) return null
  const { rowCount } = await pool.query(
    `${CHAIN_SQL} UPDATE agent_runs SET "deletedAt"=NULL,"deletedBy"=NULL WHERE id IN (SELECT id FROM chain) AND "deletedAt" > now() - interval '1 day' * ${THREAD_RECOVERY_DAYS}`, [root])
  await runListChanged(pool, root); await runChanged(pool, root)
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
  const store = schedules()
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
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock the chain's claimable rows first so a device claim in flight
    // serializes with the move: the claim's own FOR UPDATE re-reads the run
    // under the same lock and finds the device (or this finds its new status).
    await client.query(
      `${CHAIN_SQL} SELECT 1 FROM agent_runs WHERE id IN (SELECT id FROM chain) AND status='queued' FOR UPDATE`, [root])
    // A live worker's completion credential is bound to its device; moving while
    // it runs rejects the completion. Re-targeting pending or parked work is the
    // use case, so only an awake machine with an active run blocks the move.
    const { rows: [busy] } = await client.query(
      `${CHAIN_SQL} SELECT 1 FROM agent_runs r LEFT JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId"
       WHERE r.id IN (SELECT id FROM chain) AND r.status IN ('queued','preparing','running','waiting_input','finishing')
       AND COALESCE(m.state,'running') IN ('online','running','starting','restore')
       AND (m."runId" IS NOT NULL OR r.status <> 'queued') LIMIT 1`, [root])
    if (busy) { await client.query('ROLLBACK'); return null }
    // The destination only claims a repository bound on itself, and cloud
    // provisioning requires one — rebind the thread's repo onto the target.
    const { rows: [repo] } = await client.query(
      `SELECT repo."remoteUrl" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1 AND repo."userId"=$2`, [root, user.id])
    if (!repo?.remoteUrl) { await client.query('ROLLBACK'); return null }
    let deviceId: string
    if (target.deviceId === 'cloud') {
      const { rows: [cloud] } = await client.query(
        `SELECT m."deviceId" FROM cloud_machines m JOIN devices d ON d.id=m."deviceId" AND d.enabled=true AND d."removedAt" IS NULL
         WHERE m."ownerId"=$1 AND m."workspaceId"=$2 AND m."deviceId" IS NOT NULL`, [user.id, source.workspaceId])
      if (!cloud) { await client.query('ROLLBACK'); return null }
      deviceId = cloud.deviceId
    } else {
      if (!isRunId(target.deviceId)) { await client.query('ROLLBACK'); return null }
      const { rows: [device] } = await client.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2`, [target.deviceId, user.id])
      if (!device) { await client.query('ROLLBACK'); return null }
      deviceId = target.deviceId
    }
    const targetRepo = await ensureDeviceRepository(user.id, deviceId, repo.remoteUrl, client)
    // Execution moves with the thread: every run in the chain, not just the root.
    await client.query(
      `${CHAIN_SQL} UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"machineAuthority"=$4 WHERE id IN (SELECT id FROM chain)`,
      [root, deviceId, targetRepo.id, target.deviceId === 'cloud'])
    await client.query('COMMIT')
    if (target.deviceId !== 'cloud') notifyDeviceWork(deviceId)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await runListChanged(pool, root); await runChanged(pool, root)
  return true
}
