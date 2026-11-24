'use server'

import type { IssuePullRequest } from '@/lib/issue-metadata'
import type { ConversationTarget, DirectoryInput } from '@/lib/conversation-directory-input'
import type { ConversationOrganizationChange } from '@/lib/conversation-organization'
import { runAwaitingApproval, runHistoryWindow } from '@/lib/task-state-query'
import { singleFlight } from '@/lib/single-flight'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from '@/lib/run-failure-projection'

import { createHash } from 'node:crypto'
import { headers } from '@/lib/server-runtime/headers'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { deviceOnlineStates, deviceSessionOpen } from '@/lib/device-presence'
import { gatewayConfig } from '@/lib/builtin-gateway/config'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, conversationReads, devices, issues, type RunOutcome, type RunStatus } from '@/lib/db/schema'
import { runAgentName, runBotId, runBotName, runTaskPrompt } from '@/lib/run-bot-name'
import { replyLine } from '@/lib/thread-groups'
import { queryVersionWithExpiry } from '@/lib/db/query-version'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { ownerListRead } from '@/lib/live/list-read-server'
import { withDevicePresence } from '@/lib/live/presence-read'
import type { PresenceDevice } from '@/lib/live/presence'
import { changedListIds, listPositionKey, readListPositions, unchangedList, type ListPosition } from '@/lib/list-poll'
import { cacheReadAction } from '@/lib/cache-read-action'
import { beginWorkspaceListRead } from '@/lib/live/revision-read'
import { threadTitle } from '@/lib/short-title'
import { threadName } from '@/lib/issue-threads'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { joinThreadRead, threadUnread } from '@/lib/thread-reads'
import { issueVisibility } from '@/lib/issue-visibility'

/** The newest run on each issue, for the right column's 我的任务 groups (MIK-38). */
export interface TaskRun {
  issueId: string
  /** The newest run on the issue: a notification opens it beside its task (R-82). */
  runId: string
  issueTitle: string
  /** The Agent running the newest thread (Claude Code, Codex): the desktop notification's line (R-78). */
  agentName: string
  status: RunStatus
  /** How it came out once it ended, as the decision model judged it; null while running or not judged yet (R-52). */
  outcome: RunOutcome | null
  failureDetails?: CompactRunFailure | null
  /** The Bot that owns the task's newest thread, with its own bloub look (R-25); null for the Coordinator's own work. */
  bot: { id: string; name: string; color: string; shape: string } | null
  /** The coding agents (harnesses) of the task's threads, newest first: the board card's agent marks. */
  harnesses: string[]
}

export async function listTaskRuns(): Promise<TaskRun[]> {
  return (await pollTaskRuns()).items
}

/** Same owner-wide reader, with server-observed scope and window expiry. */
export async function pollTaskRuns() {
  return withDatabaseOperation('/actions/task-runs/read', readTaskRuns)
}

async function readTaskRuns() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  const visibility = await issueVisibility(session.user, false, context.workspace.id, db, { withTeamLinks: false })
  const observedAt = Date.now()
  const begun = await beginWorkspaceListRead(session.user.id, context.workspace.id, ['task_run_list'])
  // A run whose device went offline is retried (or lands in 等你) by the minute
  // run-recovery cron (sweepExpiredRunLeases), not by this poll.
  const latest = db.selectDistinctOn([agentRuns.issueId], {
    // A thread's name: its task's short title while the task keeps the title it was written from (lib/short-title.ts).
    issueId: agentRuns.issueId, runId: agentRuns.id, issueTitle: sql<string>`${issues.title}`.as('issueTitle'),
    // The conversation's own stored title and the opening of what it was asked: the run is named by threadTitle below.
    conversationTitle: agentRuns.title, asked: sql<string>`left(${runTaskPrompt}, 200)`.as('asked'), agentName: runAgentName.as('agentName'),
    status: agentRuns.status, outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'),
    botId: runBotId.as('botId'),
    expiresAt: sql<Date | null>`(select min(r."createdAt")+${runHistoryWindow} from agent_runs r where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."workspaceId"=${agentRuns.workspaceId} and r."createdAt">now()-${runHistoryWindow})`.as('expiresAt'),
    harnesses: sql<string[]>`array(select a.harness from agent_runs r join agents a on a.id=r."agentId" where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."workspaceId"=${agentRuns.workspaceId} and r."createdAt" > now() - ${runHistoryWindow} group by a.harness order by max(r."createdAt") desc)`.as('harnesses'),
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), visibility.predicate, isNotNull(agentRuns.issueId), isNull(agentRuns.deletedAt), sql`${agentRuns.createdAt} > now() - ${runHistoryWindow}`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200).as('latest_task_runs')
  // Select the same 200 issues first. Bot decoration is a one-to-one join in
  // this database; a missing or foreign bot cannot remove or duplicate a task.
  const rows = await db.select({
    issueId: latest.issueId, runId: latest.runId, issueTitle: latest.issueTitle, conversationTitle: latest.conversationTitle, asked: latest.asked, agentName: latest.agentName,
    status: latest.status, outcome: latest.outcome, failureDetails: latest.failureDetails, expiresAt: latest.expiresAt, harnesses: latest.harnesses,
    bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
  }).from(latest).leftJoin(bots, and(eq(bots.id, latest.botId), eq(bots.ownerId, session.user.id), eq(bots.workspaceId, context.workspace.id))).orderBy(latest.issueId)
  const live = await ownerListRead(session.user.id, rows.map(row => row.expiresAt), observedAt, begun)
  // `issueTitle` names the run where a list or a notification names it: the conversation's one short title (decision
  // 2026-11-13-1405), its stored one first, never the task's full title. The field keeps its name for released clients.
  const items: TaskRun[] = rows.map(({ expiresAt: _expiresAt, conversationTitle: stored, asked, ...row }) => ({ ...row,
    issueTitle: threadTitle({ title: stored, name: threadName(asked ?? '', ''), issue: { title: row.issueTitle } }),
    failureDetails: readCompactRunFailure(row.failureDetails), issueId: row.issueId! }))
  return { items, live }
}

/** A thread: one run, newest first. Its name comes from its task, else its prompt. */
export interface Thread {
  unread?: boolean
  pauseReason?: 'human_control' | 'quota_exhausted' | null
  stopReason?: string | null
  awaitingApproval?: boolean
  threadReplacedBy?: string | null
  id: string
  /** The bot that started it; null when the Coordinator dispatched it to an agent. */
  botId: string | null
  /** 'mcp' when an MCP client dispatched it: not the Coordinator's, though it has no bot either. */
  source: 'mcp' | null
  /** The Bot that dispatched it; the Agent running it is `harness` (R-78). */
  agentName: string
  issueId: string | null
  prompt: string
  /** The conversation's own stored short title, once it has one (threadTitle reads it first). */
  title?: string | null
  status: RunStatus
  createdAt: string
  updatedAt: string
  /** The opening of the agent's last reply on one plain line; null before it says anything (and for runs from before it was stored). */
  lastReply: string | null
  /** When that reply was last written; with updatedAt, the row's last activity. */
  lastReplyAt: string | null
  /** How it came out once it ended, as the decision model judged it; null while running or not judged yet (R-52). */
  outcome: RunOutcome | null
  failureDetails?: CompactRunFailure | null
  pullState?: IssuePullRequest['state'] | null
  /** The coding agent running it (claude_code, codex…); its mark is the thread's icon (R-78). */
  harness: string | null
  waitingFor?: { deviceId: string; deviceName: string; deviceType: 'laptop' | 'server'; harness: string }
}

/** The right column's threads: every run the Coordinator or a bot started in the last 30 days, latest activity first. */
export async function listThreads(): Promise<Thread[]> {
  return (await readThreads()).items!
}

/** Authorization is checked even when an existing snapshot has not changed. */
export async function pollThreads(known?: string, positions?: readonly ListPosition[]) {
  const previous = readListPositions(positions, 200)
  const valid = positions === undefined || previous !== undefined
  return readThreads(valid && known && /^[0-9a-f]{32}$/.test(known) ? known : undefined, previous)
}

export async function syncThreadList(known?: string, positions?: readonly ListPosition[]) {
  return cacheReadAction(async () => ({ snapshot: await pollThreads(known, positions) }))
}

async function readThreads(known?: string, previous?: ListPosition[]) {
  return withDatabaseOperation('/actions/threads/poll', async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const context = await loadWorkspaceContext(undefined, session.user)
    const observedAt = Date.now()
    const begun = await beginWorkspaceListRead(session.user.id, context.workspace.id, ['thread_list'])
    // Only queued local work can show "waiting for device". Presence is the
    // device session (lib/device-session.ts); the live channel watches it.
    const queuedDevices = gatewayConfig()
      ? await db.selectDistinct({ id: devices.id, sessionOpenedAt: devices.sessionOpenedAt, sessionClosedAt: devices.sessionClosedAt }).from(devices)
        .innerJoin(agentRuns, eq(agentRuns.deviceId, devices.id))
        .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), eq(devices.ownerId, session.user.id),
          eq(devices.kind, 'local'), eq(devices.enabled, true), eq(agentRuns.status, 'queued'),
          sql`${agentRuns.createdAt} > now() - ${runHistoryWindow}`))
      : []
    const presence = deviceOnlineStates(queuedDevices)
    const presenceDevices = queuedDevices.map((device): PresenceDevice => [device.id, presence.get(device.id) ?? false, 0])
    // Hash the visible waiting state, so only a session change invalidates it.
    const waitingForDevice = sql<boolean>`${devices.kind}='local' and ${agentRuns.status}='queued' and
      (${devices.enabled} is false or not ${deviceSessionOpen})`
    const snapshot = db.select({
      unread: threadUnread.as('unread'),
      id: agentRuns.id, botId: agentRuns.botId, agentName: runBotName.as('agentName'), issueId: agentRuns.issueId, prompt: sql<string>`left(${runTaskPrompt}, 200)`.as('prompt'), title: agentRuns.title,
      status: agentRuns.status, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt,
      lastReply: agentRuns.lastReply, lastReplyAt: agentRuns.lastReplyAt, source: agentRuns.source,
      deviceId: sql<string | null>`case when ${waitingForDevice} then ${devices.id} end`.as('deviceId'),
      deviceName: sql<string | null>`case when ${waitingForDevice} then ${devices.name} end`.as('deviceName'),
      deviceType: sql<'laptop' | 'server' | null>`case when ${waitingForDevice} then ${devices.deviceType} end`.as('deviceType'),
      waitingForDevice: waitingForDevice.as('waitingForDevice'),
      pullState: sql<IssuePullRequest['state'] | null>`(select p."pullRequest"->>'state' from run_publications p
        join issues i on i.id=p."issueId" and i."workspaceId"=${agentRuns.workspaceId} and i."ownershipState"='bound'
        where p."runId"=${agentRuns.id} and p."userId"=${agentRuns.userId} and p."issueId"=${agentRuns.issueId}
          and p.status='published' and p."pullRequest"->>'state' in ('open','draft','merged','closed')
          and coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' is null
          and mikka_resource_acl_allowed('account',${session.user.id},i."workspaceId",'task',i.id,'canReadContent'))`.as('pullState'),
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`.as('harness'),
      outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'),
      pauseReason: agentRuns.pauseReason, stopReason: agentRuns.stopReason, awaitingApproval: runAwaitingApproval.as('awaitingApproval'), threadReplacedBy: agentRuns.threadReplacedBy,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(devices, eq(devices.id, agentRuns.deviceId))
      .leftJoin(conversationReads, joinThreadRead(session.user.id))
      .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), isNull(agentRuns.deletedAt), sql`${agentRuns.createdAt} > now() - ${runHistoryWindow}`))
      .orderBy(desc(sql`greatest(${agentRuns.lastReplyAt}, ${agentRuns.updatedAt})`), desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200)
    const signature = await queryVersionWithExpiry(snapshot, sql`min(snapshot."createdAt")+${runHistoryWindow}`)
    const version = createHash('sha256').update(JSON.stringify([session.user.id, context.workspace.id, signature.version])).digest('hex').slice(0, 32)
    const visible = snapshot.as('thread_list_expiry')
    const live = withDevicePresence(await ownerListRead(session.user.id, [signature.expiresAt], observedAt, begun), presenceDevices, process.env, observedAt)
    // Device presence has its own bounded watcher prerequisite. Until that
    // route is ready, queued local work retains the shared slow fallback.
    // A session change pushes thread_list (lib/device-session.ts): no fallback read.
    const presenceFallback = false
    if (known === version) return { ...unchangedList(version), live, presenceFallback }
    // Reading the version first makes a concurrent edit visible on the next poll.
    const manifest = await db.select({ id: visible.id, version: sql<string>`md5(to_jsonb(thread_list_expiry)::text)` }).from(visible)
      .orderBy(desc(sql`greatest(${visible.lastReplyAt}, ${visible.updatedAt})`), desc(visible.createdAt), desc(visible.id))
    const positions = manifest.map(row => ({ id: row.id, version: createHash('sha256').update(`${session.user.id}:${row.version}`).digest('hex').slice(0, 32) }))
    // Auth, current version and the full deletion/expiry manifest belong to
    // each request. Only identical changed-row reads can join after that proof.
    return singleFlight(['/actions/threads/poll', session.user.id, context.workspace.id, version, known ?? null, listPositionKey(previous), JSON.stringify(positions)], async () => {
      const changedIds = changedListIds(positions, previous)
      const rows = changedIds.length ? await db.select().from(visible).where(inArray(visible.id, changedIds))
        .orderBy(desc(sql`greatest(${visible.lastReplyAt}, ${visible.updatedAt})`), desc(visible.createdAt), desc(visible.id)) : []
      const items: Thread[] = rows.map(({ deviceId, deviceName, deviceType, waitingForDevice, harness, ...row }) => ({
        // A cloud run waits on its own sandbox, never on a machine the person can turn on.
        ...(waitingForDevice && deviceId && deviceName !== null && deviceType
          ? { waitingFor: { deviceId, deviceName, deviceType, harness } } : {}),
        ...row, failureDetails: readCompactRunFailure(row.failureDetails), harness: harness ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
        lastReply: replyLine(row.lastReply), lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
      }))
      return { version, items, positions, ...(previous ? { delta: true as const } : {}), live, presenceFallback }
    })
  })
}

async function conversationActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  const principal = (session.user as { [enterprisePrincipal]?: EnterprisePrincipal })[enterprisePrincipal]
  const reader = {
    ...session.user,
    [tokenWorkspace]: context.workspace.id,
    ...(principal ? { [enterprisePrincipal]: principal } : {}),
  }
  return { ownerId: session.user.id, reader, workspaceId: context.workspace.id }
}

/**
 * Renames a conversation (a thread and the runs that continue it): the person's title is held to the short-title
 * bound, written on every run of the conversation, and never replaced by a generated one (decision 2026-11-13-1405).
 * Only the conversation's owner renames it.
 */
export async function renameConversation(target: ConversationTarget, title: string): Promise<ActionResult<{ title: string }, 'issueTitleInvalid' | 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { manualThreadTitle } = await import('@/lib/thread-title')
  const normalized = typeof title === 'string' && title.length <= 400 ? manualThreadTitle(title) : null
  if (!normalized) return { error: 'issueTitleInvalid' }
  const { pool } = await import('@/lib/db')
  const { resolveConversationTarget, renameStandalone } = await import('@/lib/standalone-chat-controls')
  const resolved = await resolveConversationTarget(pool, target, ownerId, workspaceId)
  if (!resolved) return { error: 'runNotFound' }
  if (resolved.kind === 'chat') {
    const renamed = await renameStandalone(pool, resolved.id, ownerId, workspaceId, normalized)
    if (!renamed) return { error: 'runNotFound' }
    await (await import('@/lib/live/lists')).groupListChanged(pool, resolved.id)
    return { title: renamed }
  }
  const { renameThreadTitle } = await import('@/lib/thread-title-server')
  const saved = await renameThreadTitle(pool, resolved.id, ownerId, title, workspaceId)
  if (!saved) return { error: 'runNotFound' }
  await (await import('@/lib/live/lists')).runListChanged(pool, resolved.id)
  return { title: saved }
}

/**
 * Asks the small model for a new title now, replacing even a manual one, because the person asked. `regenerated` is
 * false when the model was unavailable or gave nothing usable: the conversation keeps the title it had.
 */
export async function regenerateConversationTitle(target: ConversationTarget): Promise<ActionResult<{ title: string | null; regenerated: boolean }, 'runNotFound'>> {
  const { reader, ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const { resolveConversationTarget, regenerateStandalone } = await import('@/lib/standalone-chat-controls')
  const resolved = await resolveConversationTarget(pool, target, ownerId, workspaceId)
  if (!resolved) return { error: 'runNotFound' }
  if (resolved.kind === 'chat') {
    const response = await regenerateStandalone(pool, resolved.id, ownerId, workspaceId, async (owner, content, workspace) => {
      const { defaultModelAvailable } = await import('@/lib/default-model')
      if (!await defaultModelAvailable(owner)) return null
      const { generateShortTitle } = await import('@/lib/short-title-server')
      try { return await generateShortTitle(owner, content, workspace) } catch { return null }
    })
    if (!response) return { error: 'runNotFound' }
    if (response.regenerated) await (await import('@/lib/live/lists')).groupListChanged(pool, resolved.id)
    return response
  }
  const { withConversationWorkspace } = await import('@/lib/conversation-workspace')
  const read = () => withConversationWorkspace(reader, workspaceId, async () => {
    const result = await pool.query('SELECT title FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3', [resolved.id, ownerId, workspaceId])
    return result.rows[0] as { title: string | null } | undefined
  })
  if (!await read()) return { error: 'runNotFound' }
  const { defaultModelAvailable } = await import('@/lib/default-model')
  if (!await defaultModelAvailable(ownerId)) {
    const current = await read()
    return current ? { title: current.title, regenerated: false } : { error: 'runNotFound' }
  }
  const { nameThread } = await import('@/lib/thread-title-server')
  const { generateShortTitle } = await import('@/lib/short-title-server')
  let title: string | null = null
  try { title = await nameThread(pool, resolved.id, ownerId, 'regenerate', generateShortTitle) } catch (error) {
    console.error('Conversation title regenerate failed', error instanceof Error ? error.name : 'unknown')
  }
  if (title) await (await import('@/lib/live/lists')).runListChanged(pool, resolved.id)
  const current = await read()
  if (!current) return { error: 'runNotFound' }
  return { title: current.title, regenerated: !!title }
}

async function organizeTarget(target: ConversationTarget, { ownerId, workspaceId }: Awaited<ReturnType<typeof conversationActor>>, change?: ConversationOrganizationChange) {
  const { pool } = await import('@/lib/db')
  const { resolveConversationTarget, standaloneOrganization } = await import('@/lib/standalone-chat-controls')
  const resolved = await resolveConversationTarget(pool, target, ownerId, workspaceId)
  if (!resolved) return null
  if (resolved.kind === 'chat') {
    const state = await standaloneOrganization(pool, resolved.id, ownerId, workspaceId, change)
    if (change && state) await (await import('@/lib/live/lists')).groupListChanged(pool, resolved.id)
    return state
  }
  const { conversationOrganization } = await import('@/lib/conversation-organization')
  const state = await conversationOrganization(pool, ownerId, workspaceId, resolved.id, change)
  if (change && state) await (await import('@/lib/live/lists')).runListChanged(pool, resolved.id)
  return state
}

/**
 * A thread's cost for its ⋯ menu and cost popover (#2934, #2931): model receipts and machine time of every run in
 * the thread's chain, split into Mikka 额度 and usage included in the person's own subscription or key.
 * Only the thread's owner reads it; any other reader gets runNotFound.
 */
export async function readThreadCost(runId: string, groupBy: import('@/lib/thread-cost').ThreadCostGrouping = 'thread'): Promise<ActionResult<import('@/lib/thread-cost').ThreadCost, 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  // Server actions are callable with any argument; the read rejects an unknown grouping as runNotFound.
  const cost = await (await import('@/lib/thread-cost')).readThreadCost(pool, { ownerId, workspaceId, runId, groupBy })
  return cost ?? { error: 'runNotFound' }
}

/**
 * A thread's summary for its header and right column (#2935): cost totals, machine, repository, branch and context
 * in one read (lib/thread-summary.ts). Only the thread's owner in its workspace reads it; any other reader gets runNotFound.
 */
export async function readThreadSummary(runId: string): Promise<ActionResult<import('@/lib/thread-summary-read').ThreadSummary, 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const catalogue = await (await import('@/lib/model-catalog-server')).modelCatalog()
  const summary = await (await import('@/lib/thread-summary-read')).readThreadSummary(pool, { ownerId, workspaceId, runId, catalogue })
  return summary ?? { error: 'runNotFound' }
}

/**
 * A thread's machine workspace for the right column's Files and Setup tabs (#2928, #2940): its checkout, machine,
 * frozen Environment and uploads (lib/thread-workspace.ts). Only the thread's owner reads it; anyone else gets runNotFound.
 */
export async function readThreadWorkspace(runId: string): Promise<ActionResult<import('@/lib/thread-workspace-read').ThreadWorkspace, 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const read = await (await import('@/lib/thread-workspace-read')).readThreadWorkspace(pool, { ownerId, workspaceId, runId })
  return read ?? { error: 'runNotFound' }
}

/**
 * The live sandbox's latest recorded load (CPU, memory, disk) for the Setup tab, read from the provider without waking
 * it; null for a thread that runs elsewhere or is not running. Only the thread's owner reads it.
 */
export async function readThreadMachineMetrics(runId: string): Promise<import('@/lib/thread-workspace-read').ThreadMachineMetrics | null> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const { readComputerMetrics } = await import('@/lib/computer/e2b-provider')
  try {
    return await (await import('@/lib/thread-workspace-read')).readThreadMachineMetrics(pool, { ownerId, workspaceId, runId },
      (owner, sandboxId, start, end) => readComputerMetrics(owner, sandboxId, start, end, AbortSignal.timeout(12_000)))
  } catch (failure) {
    // The provider is unreachable or the sandbox is gone: the tab shows no numbers, never stale or made-up ones.
    console.warn('[thread-workspace] machine metrics unavailable', failure instanceof Error ? failure.message : failure)
    return null
  }
}

/** The files the person sent in their chat with a Bot, for the Files tab's Uploads view; null when the Bot is not in this workspace. */
export async function readBotChatUploads(botId: string): Promise<ActionResult<import('@/lib/thread-workspace-read').ThreadWorkspace['uploads'], 'botNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const uploads = await (await import('@/lib/thread-workspace-read')).readBotChatUploads(pool, { ownerId, workspaceId, botId })
  return uploads ?? { error: 'botNotFound' }
}

/**
 * The sub-agents a thread dispatched (#2939): its child runs, oldest first, each with what its card shows. Only the
 * thread's owner reads them; any other reader gets runNotFound. A child's change reaches the parent's `run` live key.
 */
export async function readSubagentRuns(runId: string): Promise<ActionResult<import('@/lib/subagent-run-read').SubagentRun[], 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const runs = await (await import('@/lib/subagent-run-read')).readSubagentRuns(pool, { ownerId, workspaceId, runId })
  return runs ?? { error: 'runNotFound' }
}

/** Every run of the thread's chain, so each list that shows one of them reads again. */
async function threadListsChanged(runIds: readonly string[]) {
  const { pool } = await import('@/lib/db')
  const { runListChanged } = await import('@/lib/live/lists')
  for (const id of runIds) await runListChanged(pool, id)
}

async function chainRunIds(ownerId: string, runId: string) {
  const { pool } = await import('@/lib/db')
  const chain = await (await import('@/lib/run-chain')).readRunChain(pool, ownerId, runId)
  return chain?.attempts.map(attempt => attempt.runId) ?? []
}

/**
 * Deletes a thread (#2936, ⋯ 删除): it leaves every list at once and can be restored for 30 days
 * (lib/thread-lifecycle.ts). A thread that is still working is not deleted. Only its owner, in its Workspace.
 */
export async function removeThread(runId: string): Promise<ActionResult<import('@/lib/thread-lifecycle-owner').ThreadDeletion, 'runNotFound' | 'threadWorking'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const result = await (await import('@/lib/thread-lifecycle-owner')).deleteThread(pool, { ownerId, workspaceId, runId })
  if (result === 'working') return { error: 'threadWorking' }
  if (!result) return { error: 'runNotFound' }
  await threadListsChanged(await chainRunIds(ownerId, runId))
  return result
}

/** Restores a thread deleted less than 30 days ago (#2936). Only its owner, in its Workspace. */
export async function undoRemoveThread(runId: string): Promise<ActionResult<import('@/lib/thread-lifecycle-owner').ThreadDeletion, 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const result = await (await import('@/lib/thread-lifecycle-owner')).restoreThread(pool, { ownerId, workspaceId, runId })
  if (!result) return { error: 'runNotFound' }
  await threadListsChanged(await chainRunIds(ownerId, runId))
  return result
}

/** A thread's tags (#2936, ⋯ 标签); with `tags`, replaces them (lib/thread-lifecycle.ts normalizeThreadTags). Owner only. */
export async function threadTags(runId: string, tags?: string[]): Promise<ActionResult<{ threadId: string; tags: string[] }, 'runNotFound' | 'validationGeneric'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const lifecycle = await import('@/lib/thread-lifecycle-owner')
  const normalized = tags === undefined ? undefined : lifecycle.normalizeThreadTags(tags)
  if (normalized === null) return { error: 'validationGeneric' }
  const { pool } = await import('@/lib/db')
  const result = await lifecycle.threadTags(pool, { ownerId, workspaceId, runId }, normalized)
  if (!result) return { error: 'runNotFound' }
  if (normalized) await threadListsChanged([result.threadId])
  return result
}

/**
 * What ⋯ 做成自动化 opens the automation editor with (#2936): every run sent to this thread. The editor saves it through
 * createAutomation, which checks the thread again. Owner only; a thread with no task cannot run again.
 */
export async function threadAutomationSeed(runId: string): Promise<ActionResult<{ singleThreadId: string; title: string; prompt: string }, 'runNotFound' | 'threadCannotContinue'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const seed = await (await import('@/lib/thread-lifecycle-owner')).threadAutomationSeed(pool, { ownerId, workspaceId, runId })
  if (seed === 'noTask') return { error: 'threadCannotContinue' }
  return seed ?? { error: 'runNotFound' }
}

type ForkError = 'runNotFound' | 'messageRequired' | 'validationGeneric' | 'threadCannotContinue' | 'threadReplaced' | 'threadModelUnavailable' | 'agentRepoMissing' | 'runInvalid'
/**
 * Fork from a message (#2936, ⋯ 分叉 and the message's More menu): a new thread of the same task that starts from this
 * thread up to the message, with the person's instruction (lib/thread-continue.ts forkThread). The source thread is
 * replaced by it (one thread per task). Owner only.
 */
export async function forkThreadFrom(input: { runId: string; itemId?: string | null; mode: 'full' | 'summary'; text: string; requestId: string }): Promise<ActionResult<{ runId: string; threadId: string; replacedThreadId: string | null }, ForkError | import('@/lib/action-result').ActionErrorCode>> {
  const { ownerId, workspaceId } = await conversationActor()
  try {
    return await (await import('@/lib/thread-continue')).forkThread(ownerId, workspaceId, input)
  } catch (error) {
    if (error instanceof ActionFailureError) return { error: error.code as import('@/lib/action-result').ActionErrorCode }
    throw error
  }
}

export async function readConversationOrganization(target: ConversationTarget) {
  return organizeTarget(target, await conversationActor())
}

export async function setConversationOrganization(target: ConversationTarget, change: ConversationOrganizationChange) {
  const actor = await conversationActor()
  if (!change || !['archived', 'pinned'].includes(change.field) || typeof change.value !== 'boolean') {
    throw new ActionFailureError('validationGeneric')
  }
  return organizeTarget(target, actor, change)
}

/** ⋯ menu thread actions (#2931) — same lifecycle functions the /api/threads routes call; only the owner succeeds. */
export async function shareThread(runId: string): Promise<ActionResult<{ shareId: string; url: string }, 'runNotFound'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  if (!lc.isRunId(runId)) return { error: 'runNotFound' }
  const share = await lc.createThreadShare(reader, runId)
  return share ? { shareId: share.shareId, url: `/threads/shared/${share.token}` } : { error: 'runNotFound' }
}

export async function revokeThreadShare(runId: string): Promise<ActionResult<{ revoked: number }, 'runNotFound'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  if (!lc.isRunId(runId)) return { error: 'runNotFound' }
  const revoked = await lc.revokeThreadShares(reader, runId)
  return revoked === null ? { error: 'runNotFound' } : { revoked }
}

export async function forkThread(runId: string, mode?: 'full' | 'summary'): Promise<ActionResult<{ runId: string }, 'runNotFound'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  if (!lc.isRunId(runId) || (mode !== undefined && mode !== 'full' && mode !== 'summary')) return { error: 'runNotFound' }
  const run = await lc.spawnThread(reader, runId, { relation: 'fork', mode: mode ?? 'full' })
  return run ? { runId: run.id } : { error: 'runNotFound' }
}

export async function updateThread(runId: string, input: { taskId?: string | null; tags?: string[] }): Promise<ActionResult<{ updated: true }, 'runNotFound' | 'taskNotFound' | 'validationGeneric'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  const taskId = input?.taskId === undefined ? undefined : input.taskId === null ? null : typeof input.taskId === 'string' && lc.isRunId(input.taskId) ? input.taskId : undefined
  const tags = input?.tags === undefined ? undefined : Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0 && tag.trim().length <= 60).slice(0, 20).map(tag => tag.trim()) : undefined
  if (!lc.isRunId(runId) || (input?.taskId !== undefined && taskId === undefined) || (input?.tags !== undefined && tags === undefined) || (taskId === undefined && tags === undefined))
    return { error: 'validationGeneric' }
  const run = await lc.patchThread(reader, runId, { ...(taskId !== undefined ? { taskId } : {}), ...(tags ? { tags } : {}) })
  return run === 'forbidden' ? { error: 'taskNotFound' } : run ? { updated: true } : { error: 'runNotFound' }
}

export async function deleteThread(runId: string): Promise<ActionResult<{ recoveryDays: number }, 'runNotFound'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  if (!lc.isRunId(runId)) return { error: 'runNotFound' }
  const deleted = await lc.deleteThread(reader, runId)
  return deleted === null ? { error: 'runNotFound' } : { recoveryDays: 30 }
}

export async function restoreThread(runId: string): Promise<ActionResult<{ restored: true }, 'runNotFound' | 'restoreExpired'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  if (!lc.isRunId(runId)) return { error: 'runNotFound' }
  const restored = await lc.restoreThread(reader, runId)
  return restored === null ? { error: 'runNotFound' } : restored ? { restored: true } : { error: 'restoreExpired' }
}

export async function threadAutomation(runId: string, definition: Record<string, unknown>): Promise<ActionResult<Record<string, unknown>, 'runNotFound' | 'scheduleRejected' | 'validationGeneric'>> {
  const { reader } = await conversationActor()
  const lc = await import('@/lib/thread-lifecycle')
  if (!lc.isRunId(runId) || !definition || typeof definition !== 'object' || Array.isArray(definition)) return { error: 'validationGeneric' }
  const result = await lc.threadToAutomation(reader, runId, definition)
  return result === 'forbidden' ? { error: 'scheduleRejected' } : result ? result as Record<string, unknown> : { error: 'runNotFound' }
}

export async function listConversations(input: DirectoryInput) {
  const { reader, workspaceId } = await conversationActor()
  const { conversationDirectory } = await import('@/lib/conversation-directory')
  const { pool } = await import('@/lib/db')
  const projectId = typeof input?.projectId === 'string' ? input.projectId : undefined
  if (!projectId) return conversationDirectory(pool, reader, workspaceId, input)
  // Projects and their task links live in the workspace database; the reader's own project ACL picks the tasks.
  const [{ accessibleProjects }, { projectDb }] = await Promise.all([import('@/lib/project-access'), import('@/lib/db/projects')])
  const [project] = await accessibleProjects(reader, projectDb, workspaceId, projectId)
  if (!project) throw new ActionFailureError('projectNotFound')
  return conversationDirectory(pool, reader, workspaceId, input, { projectIssueIds: project.issueIds })
}

export async function listConversationSidebar() {
  const { reader, workspaceId } = await conversationActor()
  const { conversationSidebar } = await import('@/lib/conversation-directory')
  const { pool } = await import('@/lib/db')
  return conversationSidebar(pool, reader, workspaceId, undefined, { nestChecks: true })
}

/** A workspace switch between composing and searching invalidates the old picker. */
export async function findThreadReferences(expectedWorkspaceId: string, query: string, kind?: 'task' | 'thread' | 'pr' | 'bot') {
  const { reader, workspaceId } = await conversationActor()
  if (expectedWorkspaceId !== workspaceId || typeof query !== 'string' || query.length > 120 ||
    (kind !== undefined && !['task', 'thread', 'pr', 'bot'].includes(kind))) throw new ActionFailureError('validationGeneric')
  const { searchThreadReferences } = await import('@/lib/thread-reference-search')
  return searchThreadReferences(reader, workspaceId, query.trim(), kind)
}
