'use server'

import { readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'

import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { desktopHumanSessionId } from '@/lib/desktop-rpc/session'
import { deploymentSwitch } from '@/lib/deployment-switches'
import { withFreshSession } from '@/lib/fresh-session'

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { headers } from '@/lib/server-runtime/headers'
import { threadModelChoice, type ThreadModelChoice } from '@/lib/thread-model-choice'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SelectResult } from 'drizzle-orm/query-builders/select.types'
import { z } from 'zod'
import { cacheReadAction } from '@/lib/cache-read-action'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { threadReadReceipts } from '@/lib/thread-reads'
import { db, pool } from '@/lib/db'
import {
  agents, agentRuns, coordinatorEvents, deviceRepos, devices, runMessages, users,
  type SupportedHarness,
} from '@/lib/db/schema'
import { issueDeviceToken } from '@/lib/device-link'
import { deviceOnlineStates } from '@/lib/device-presence'
import { withDevicePresence } from '@/lib/live/presence-read'
import type { PresenceDevice } from '@/lib/live/presence'
import { devicePresenceView, type PresenceReason } from '@/lib/device-scheduling'
import { removeOwnedDevice, renameOwnedDevice, setOwnedDeviceDescription, setOwnedDeviceEnabled } from '@/lib/device-removal'
import { enqueueDeviceCommand, type DeviceCommandKind } from '@/lib/device-management'
import { listSshHosts } from '@/lib/ssh'
import { citationSources } from '@/lib/coordinator/store'
import { requestRunStop } from '@/lib/agent-runs'
import { sendThreadMessage } from '@/lib/thread-continue'
import { factoryEventId } from '@/lib/factory/event-id'
import { FactoryError } from '@/lib/factory/contract'
import { readLatestThreadHistory, readThreadHistory } from '@/lib/thread-history-read'
import { threadHistoryInput, threadHistoryPosition, type ThreadHistoryInput, type ThreadHistoryPage, type ThreadHistoryPosition } from '@/lib/thread-history'
import { readThreadChunks, threadChunkCursor, type ThreadChunkCursor } from '@/lib/thread-chunks'
import { executionBotName, runBotId, runBotName, threadNameLines } from '@/lib/run-bot-name'
import { requireIssueAccessWithoutBody } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { ISSUE_THREAD_LIMIT, canReadThread, projectIssueThreads, threadQuestionRunId, withRunChain, type IssueThread } from '@/lib/issue-threads'
import { readThreadQuestionState, type ThreadQuestionDeadline } from '@/lib/issue-thread-questions'
import { runIsActive } from '@/lib/issue-run-conversation'
import { issueThreadListText } from '@/lib/issue-thread-list-projection'
import { listIssueRunChains, readRunChain, readRunChainCheckpoint } from '@/lib/run-chain'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { parseUnifiedDiff, type ThreadChangesResult } from '@/lib/thread-changes'
import { threadPromptView } from '@/lib/thread-prompt'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { actAs, requireUser } from '@/lib/acting-user'

const getUserId = async () => (await requireUser()).id

async function getWorkspaceReader() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { id: session.user.id, [tokenWorkspace]: context.workspace.id, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
}

async function withOwnWorkspaceRun<T>(runId: string, work: (userId: string) => Promise<T>): Promise<T> {
  const reader = await getWorkspaceReader()
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, reader.id), eq(agentRuns.workspaceId, reader[tokenWorkspace]))).limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  return actAs(reader, () => work(reader.id))
}

export interface DeviceRepoView {
  id: string
  repoPath: string
  baseBranch: string | null
  verifyCommand: string | null
}

export interface DeviceView {
  id: string
  name: string
  description?: string | null
  deviceType: 'laptop' | 'server'
  hostname: string | null
  platform: string | null
  arch: string | null
  harnesses: HarnessInfo[]
  online: boolean
  presenceReason?: PresenceReason
  offlineDays?: number | null
  /** 参与调度 (decision 2026-11-02-1400): off, Mikka never sends this device a run. */
  enabled: boolean
  lastSeenAt: Date | null
  repos: DeviceRepoView[]
}

export interface AgentView {
  id: string
  name: string
  description: string
  instructions: string
  harness: SupportedHarness
  deviceId: string | null
  deviceName: string | null
}

/** Every local device this person owns, with its repository history. */
export async function listDevices(): Promise<DeviceView[]> {
  return (await readDevices(await getUserId())).devices
}

/**
 * The device list for 设备 settings. Registration, a rename, enable/disable,
 * removal, a repository and a device session opening or closing push
 * `device_list` (lib/device-session.ts), so nothing needs a fallback read.
 */
export async function pollDevices() {
  const userId = await getUserId()
  const { devices: items, observedAt, presenceDevices } = await readDevices(userId)
  const { ownerListRead } = await import('@/lib/live/list-read-server')
  const live = withDevicePresence(await ownerListRead(userId, [], observedAt), presenceDevices, process.env, observedAt)
  return { devices: items, live, presenceFallback: false }
}

async function readDevices(userId: string) {
  const rows = await db.select({
    id: devices.id, name: devices.name, description: devices.description, deviceType: devices.deviceType, hostname: devices.hostname, platform: devices.platform, arch: devices.arch,
    harnesses: devices.harnesses, lastSeenAt: devices.lastSeenAt, enabled: devices.enabled,
    sessionOpenedAt: devices.sessionOpenedAt, sessionClosedAt: devices.sessionClosedAt,
  }).from(devices).where(and(eq(devices.ownerId, userId), eq(devices.kind, 'local'), isNull(devices.removedAt))).orderBy(desc(devices.lastSeenAt))
  const repos = rows.length
    ? await db.select({
      id: deviceRepos.id, deviceId: deviceRepos.deviceId, repoPath: deviceRepos.repoPath, baseBranch: deviceRepos.baseBranch, verifyCommand: deviceRepos.verifyCommand,
    }).from(deviceRepos).where(inArray(deviceRepos.deviceId, rows.map(row => row.id)))
    : []
  const observedAt = Date.now()
  const presence = deviceOnlineStates(rows)
  const views: DeviceView[] = rows.map(device => ({
    id: device.id, name: device.name, description: device.description, deviceType: device.deviceType, hostname: device.hostname, platform: device.platform, arch: device.arch,
    harnesses: device.harnesses, lastSeenAt: device.lastSeenAt, enabled: device.enabled,
    online: presence.get(device.id) ?? false,
    ...devicePresenceView(device.lastSeenAt, presence.get(device.id) ?? false, observedAt),
    repos: repos.filter(repo => repo.deviceId === device.id).map(repo => ({
      id: repo.id, repoPath: repo.repoPath, baseBranch: repo.baseBranch, verifyCommand: repo.verifyCommand,
    })),
  }))
  const presenceDevices = rows.map((device): PresenceDevice => [device.id, presence.get(device.id) ?? false, 0])
  return { devices: views, observedAt, presenceDevices }
}

/** Mints a device token. The plaintext is returned once and never stored. */
async function createDeviceTokenBody(input: { name: string }): Promise<ActionResult<{ token: string }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ name: z.string().trim().max(60) }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNameTooLong' }
    const token = await issueDeviceToken(userId, parsed.data.name)
    return { token }
  })
}

export async function createDeviceToken(...args: Parameters<typeof createDeviceTokenBody>) { return withFreshSession(() => createDeviceTokenBody(...args)) }

export interface SshHostView {
  alias: string
  hostName: string | null
  user: string | null
}

/**
 * Whether the orchestrator may dispatch runs to this device. Off keeps the
 * device registered and visible; it simply gets no work.
 */
export async function setDeviceEnabled(input: { deviceId: string; enabled: boolean }): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ deviceId: z.uuid(), enabled: z.boolean() }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNotFound' }
    return setOwnedDeviceEnabled(userId, parsed.data.deviceId, parsed.data.enabled)
  })
}

/** Renames one of the person's devices (1–60 characters); the daemon keeps the new name. */
export async function renameDevice(id: string, name: string): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(async () => renameOwnedDevice(await getUserId(), id, name))
}

/** Saves or clears the signed-in owner's device description. */
export async function setDeviceDescription(id: string, description: string): Promise<ActionResult<{ id: string; description: string | null }>> {
  return runAction(async () => setOwnedDeviceDescription(await getUserId(), id, description))
}

/**
 * Removes one of the person's devices. Refused with `deviceHasActiveRuns`
 * while a thread is live on it. Its daemon credentials are revoked at once;
 * past threads keep their device (lib/device-removal.ts).
 */
export async function removeDevice(id: string): Promise<ActionResult<{ id: string; revokedTokens: number; uninstall: 'queued' | 'not_possible' }>> {
  return runAction(async () => removeOwnedDevice(await getUserId(), id))
}

/** The hosts in this server's `~/.ssh/config`, offered as one-click targets. */
export async function listLocalSshHosts(): Promise<SshHostView[]> {
  await getUserId()
  return listSshHosts()
}

export async function listAgents(): Promise<AgentView[]> {
  const userId = await getUserId()
  const rows = await db.select({
    id: agents.id, name: executionBotName, description: agents.description, instructions: agents.instructions,
    harness: agents.harness, deviceId: agents.deviceId, deviceName: devices.name,
  }).from(agents).leftJoin(devices, eq(devices.id, agents.deviceId))
    .where(and(eq(agents.userId, userId), sql`not exists (select 1 from bot_cloud_runtimes bcr where bcr."agentId" = ${agents.id})`)).orderBy(asc(agents.name))
  return rows
}

/** Who currently collaborates on the issue (R-26): they see that its threads exist. */
async function issueThreadAccess(issueId: string) {
  const { issue, user, teamId } = await requireIssueAccessWithoutBody(issueId)
  if (!issue.workspaceId) throw new ActionFailureError('issueNotFound')
  const members = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, issue.workspaceId), eq(workspaceMembers.status, 'active')))
  return { issue, user, teamId, memberIds: new Set(members.map(member => member.id)) }
}

const threadColumns = {
  id: agentRuns.id, issueId: agentRuns.issueId, userId: agentRuns.userId, workspaceId: agentRuns.workspaceId, agentId: agentRuns.agentId, status: agentRuns.status, title: agentRuns.title, prompt: agentRuns.prompt, promptTaskStart: agentRuns.promptTaskStart, promptTaskLength: agentRuns.promptTaskLength,
  // Only the report's summary: runSummaryText reads nothing else of it.
  sessionId: agentRuns.sessionId, deviceRepoId: agentRuns.deviceRepoId, failureDetails: agentRuns.failureDetails, report: sql<Record<string, unknown> | null>`case when jsonb_typeof(${agentRuns.report}) = 'object' then jsonb_build_object('summary', ${agentRuns.report}->'summary') end`, error: agentRuns.error, createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt,
  agentName: runBotName, harness: agents.harness, ownerName: users.name, stopRequestedAt: agentRuns.stopRequestedAt, pauseReason: agentRuns.pauseReason, outcome: agentRuns.outcome, kind: agentRuns.kind,
  botColor: sql<string | null>`(select b.color from bots b where b.id = ${runBotId})`, botShape: sql<string | null>`(select b.shape from bots b where b.id = ${runBotId})`,
  // Who did the stretch (lib/issue-threads.ts threadProfile): the frozen Profile's public summary and its current mark.
  profile: sql<unknown>`case when ${agentRuns.agentDefinition}->'agentProfile' is null then null else jsonb_build_object(
    'profileId',${agentRuns.agentDefinition}->'agentProfile'->'profileId','name',${agentRuns.agentDefinition}->'agentProfile'->'name',
    'roles',${agentRuns.agentDefinition}->'agentProfile'->'definition'->'roles','description',${agentRuns.agentDefinition}->'agentProfile'->'definition'->'description',
    'icon',(select p.icon from factory_agent_profiles p where p.id::text=${agentRuns.agentDefinition}->'agentProfile'->>'profileId' and p."ownerId"=${agentRuns.userId}),
    'color',(select p.color from factory_agent_profiles p where p.id::text=${agentRuns.agentDefinition}->'agentProfile'->>'profileId' and p."ownerId"=${agentRuns.userId})) end`,
}

// A read after a cursor: the client holds the run's prompt (immutable), so only what names the thread is read.
const threadCursorColumns = { ...threadColumns, prompt: sql<string>`coalesce(${threadNameLines}, '')` }

// Read-only location and changes need authority, not conversation content.
const threadIdentityColumns = { id: agentRuns.id, userId: agentRuns.userId, workspaceId: agentRuns.workspaceId }

const { title: _title, prompt: _prompt, promptTaskStart: _promptTaskStart, promptTaskLength: _promptTaskLength, sessionId: _sessionId, deviceRepoId: _deviceRepoId, report: _report, error: _error, ...threadListColumns } = threadColumns

/** The issue's threads, as much of each as this viewer may see (R-62). */
export async function listIssueThreads(issueId: string): Promise<IssueThread[]> {
  return withDatabaseOperation('/actions/threads/issue-list', async () => (await readIssueThreads(issueId)).threads)
}

/** The same list, plus the channel its `issue_threads` key arrives on: the issue's
 * workspace, or the owner's home for a personal issue; null reads once a minute. */
export async function pollIssueThreads(issueId: string, includeTaskWork = false, activityCursor?: { version?: string; positions?: import('@/lib/list-poll').ListPosition[]; paged?: boolean }) {
  return withDatabaseOperation('/actions/threads/issue-list', async () => {
    const { threads, issue, user, teamId } = await readIssueThreads(issueId)
    const [{ documentLiveWorkspace }, { workspacePool }] = await Promise.all([import('@/lib/live/panels'), import('@/lib/workspace-db')])
    const workspaceId = await documentLiveWorkspace(pool, workspacePool, issue.id, user.id)
    const work = includeTaskWork && issue.workspaceId
      ? await (await import('@/lib/task-work-read')).readTaskWork(user, issue.workspaceId, issue.id)
      : null
    const snapshot = { threads, live: { workspaceId }, work }
    if (!includeTaskWork) return snapshot
    const { listIssueConnections } = await import('@/app/actions/issue-operations')
    const connections = await listIssueConnections(issue.id)
    const { pollIssueVersionSummaries, pollIssueActivityPage } = await import('@/app/actions/issues')
    const activity = activityCursor?.paged
      ? await pollIssueActivityPage(issue.id, activityCursor.version)
      : await pollIssueVersionSummaries(issue.id, activityCursor?.version, activityCursor?.positions)
    if (activity.error) throw new ActionFailureError(activity.error)
    if (activity.viewerId !== user.id) throw new ActionFailureError('issueNotFound')
    return { ...snapshot, teamId, connections, activity: activity.snapshot, viewerId: user.id }
  })
}

export type IssueWorkSnapshot = Extract<Awaited<ReturnType<typeof pollIssueThreads>>, { viewerId: string }>

/** Reuse the authorized content read, then release its document lock before
 * reading the Work view. The stable task and both viewer identities must agree. */
export async function pollTaskDetail(issueId: string, known?: string, activityCursor?: { version?: string; positions?: import('@/lib/list-poll').ListPosition[]; paged?: boolean }) {
  return cacheReadAction(async () => {
    const { pollIssue } = await import('@/app/actions/issues')
    const document = await pollIssue(issueId, known)
    if (document.error) throw new ActionFailureError(document.error)
    const work = await pollIssueThreads(issueId, true, activityCursor)
    if (!('activity' in work) || work.viewerId !== document.viewerId) throw new ActionFailureError('issueNotFound')
    return { ...document, taskWork: work }
  })
}

async function readIssueThreads(issueId: string) {
  const { issue, user, teamId, memberIds } = await issueThreadAccess(issueId)
  const result = (threads: IssueThread[]) => ({ threads, issue, user, teamId })
  if (!memberIds.has(user.id)) return result([])
  // BE-18: fold continuation chains by root first, then take the newest ISSUE_THREAD_LIMIT
  // roots, so continuations never use up a slot (lib/run-chain.ts). Read-only, no locks.
  const chains = await listIssueRunChains(pool, issue.id, [...memberIds], ISSUE_THREAD_LIMIT)
  if (!chains.length) return result([])
  const rows = await db.select({ ...threadListColumns, ...issueThreadListText(user.id) }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.issueId, issue.id), eq(agentRuns.workspaceId, issue.workspaceId!), inArray(agentRuns.userId, [...memberIds]), inArray(agentRuns.id, chains.map(chain => chain.rootRunId))))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(ISSUE_THREAD_LIMIT)
  const byRoot = new Map(chains.map(chain => [chain.rootRunId, chain]))
  return result((await threadQuestions(projectIssueThreads(rows, issue.id, user.id, memberIds).map(thread => withRunChain(thread, byRoot.get(thread.id))), user.id)).threads)
}

/**
 * One thread the viewer may read (canReadThread). With a task, the task's collaborators
 * decide (issueThreadAccess). With none (`issueId` null), the active members of the
 * workspace of the bot that dispatched it, or its owner alone when no bot did
 * (taskFreeThreadMembers); either way only its owner reads it.
 */
type ThreadColumns = typeof threadColumns | typeof threadCursorColumns | typeof threadIdentityColumns
type ReadableThreadResult<T extends ThreadColumns> = {
  row: SelectResult<T, 'partial', { agent_runs: 'not-null'; agents: 'not-null'; user: 'nullable' }>
  user: { id: string }
}

async function readableThreadSelect(issueId: string, runId: string, columns: ThreadColumns): Promise<ReadableThreadResult<ThreadColumns>> {
  const access = await issueThreadAccess(issueId)
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [row] = await db.select(columns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.issueId, access.issue.id), eq(agentRuns.workspaceId, access.issue.workspaceId!))).limit(1)
  if (!row || !canReadThread(row.userId, access.user.id, access.memberIds)) throw new ActionFailureError('runNotFound')
  return { row, user: access.user }
}

function readableThread(issueId: string | null, runId: string, columns: typeof threadColumns): Promise<ReadableThreadResult<typeof threadColumns>>
function readableThread(issueId: string | null, runId: string, columns: typeof threadCursorColumns): Promise<ReadableThreadResult<typeof threadCursorColumns>>
function readableThread(issueId: string | null, runId: string, columns: typeof threadIdentityColumns): Promise<ReadableThreadResult<typeof threadIdentityColumns>>
async function readableThread(issueId: string | null, runId: string, columns: ThreadColumns): Promise<ReadableThreadResult<ThreadColumns>> {
  if (issueId !== null) return readableThreadSelect(issueId, runId, columns)
  const user = await getWorkspaceReader()
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  // A caller that doesn't know the task (a thread opened by run id alone) still
  // reaches an attached run: the run's own binding names the issue whose access
  // check decides. Unattached runs keep the owner-only rule below.
  const [binding] = await db.select({ issueId: agentRuns.issueId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (binding?.issueId) {
    // A denied task read must not reveal the run exists: collapse the task's
    // refusal into the same runNotFound a missing run returns.
    try {
      return await readableThreadSelect(binding.issueId, runId, columns)
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === 'issueNotFound') throw new ActionFailureError('runNotFound', undefined, undefined, { cause: error })
      throw error
    }
  }
  const [row] = await db.select(columns)
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, user.id), eq(agentRuns.workspaceId, user[tokenWorkspace]), isNull(agentRuns.issueId))).limit(1)
  if (!row) throw new ActionFailureError('runNotFound')
  return { row, user }
}

/**
 * The task a thread works on, for a thread opened from its address alone (R-82):
 * `{ issueId: null }` for a thread with no task. Null unless the viewer may read
 * that thread, exactly as getIssueThread decides.
 */
export async function findThreadIssue(runId: string): Promise<{ issueId: string | null } | null> {
  return withDatabaseOperation('/actions/threads/find-issue', () => readThreadIssue(runId))
}

async function readThreadIssue(runId: string): Promise<{ issueId: string | null } | null> {
  if (!z.uuid().safeParse(runId).success) return null
  const [run] = await db.select({ ...threadIdentityColumns, issueId: agentRuns.issueId, workspaceId: agentRuns.workspaceId })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  try {
    if (run.issueId === null) {
      const user = await getWorkspaceReader()
      // The first read already has the task-free identity. Authorization still
      // selects the current workspace and checks active membership on every call.
      return run.userId === user.id && run.workspaceId === user[tokenWorkspace] ? { issueId: null } : null
    }
    await readableThread(run.issueId, runId, threadIdentityColumns)
    return { issueId: run.issueId }
  } catch { return null }
}

export interface IssueThreadDetail {
  readReceipts?: Awaited<ReturnType<typeof threadReadReceipts>>
  delivery?: import('@/lib/thread-delivery').ThreadDeliveryView
  /** Authorized scopes for every attempt; browser state never guesses them. */
  live?: { viewerId?: string; runs: import('@/lib/live/panels').ThreadLiveReference[]; issueWorkspaceId: string | null; questionDeadline: ThreadQuestionDeadline | null; revisions?: Record<string, number> }
  /** The owner sees the stop deadline too, so a reload does not reset the timeout. */
  thread: IssueThread & { failureDetails: RunFailure | null; prompt: string; /** `prompt` is the task alone; the Agent also received system instructions (getThreadInstructions). */ hasInstructions?: true; stopRequestedAt: Date | null; /** Host projection for the existing controls; mutations still revalidate. */ replyAvailable: boolean; retryAvailable: boolean; feedbackEligible:boolean; /** The latest masked run error or the host's fixed wake failure. */ error: string | null; /** The owner's own: quota switches and a quota pause (lib/run-quota-view.ts). */ quota: import('@/lib/run-quota-view').ThreadQuotaView | null; /** Host-confirmed provider recovery, within this owner's thread chain. */ modelFallback?: import('@/lib/run-model-fallback-view').ThreadModelFallbackView[] | null; /** Keep polling while the host prepares a continuation; no uncommitted switch is displayed. */ modelFallbackPending?: boolean }
  historyPage?: ThreadHistoryPage
  messageUpdates?: IssueThreadDetail['messages']
  chunks: { chunk: Record<string, unknown>; at: Date }[]
  messages: { id: string; sourceRunId?:string|null; editable?:boolean; submissionId?: string; text: string; at: Date; author: string; image: string | null; mine: boolean }[]
  /** Where `chunks` ends; passed back, the next read returns only later chunks. */
  chunkCursor: ThreadChunkCursor | null
  /** `chunks` holds only the chunks after the cursor that was passed: append them to the ones held. */
  chunksAppend: boolean
  /** A cursor read: `thread.prompt` is left out; the held read's prompt stands (mergeThreadChunks). */
  promptOmitted?: true
  /**
   * What this thread's run holds (lib/context-usage.ts): an estimate from stored
   * text, never a provider count. Optional because a page open across a deploy
   * may still be served by a build that predates it, like every other host
   * projection here.
   */
  context?: import('@/lib/context-usage').ContextUsage
  composerModel?: import('@/lib/context-usage').ContextUsage['composerModel']
}

/**
 * Which of the viewer's own threads end on a run that owes them an answer, or whose answer is
 * resuming them. Only the owner may answer (lib/agent-runs.ts), and only while Factory lifecycle
 * is on; the answer itself goes through sendIssueThreadMessage to the chain's latestRunId.
 * A teammate's thread or a live run never carries a question.
 */
async function threadQuestions(threads: readonly IssueThread[], viewerId: string): Promise<{ threads: IssueThread[]; deadline: ThreadQuestionDeadline | null }> {
  // Keyed by the chain's live end (threadQuestionRunId), so an earlier attempt's answered question never resurfaces.
  const asked = new Map(threads.flatMap(thread => {
    const runId = thread.ownedByCurrentUser ? threadQuestionRunId(thread) : null
    return runId ? [[thread.id, runId] as const] : []
  }))
  if (!asked.size || !deploymentSwitch('factoryRouting') || !deploymentSwitch('factoryLifecycle')) return { threads: [...threads], deadline: null }
  const { states, deadline } = await readThreadQuestionState(pool, [...new Set(asked.values())], viewerId)
  return { threads: await Promise.all(threads.map(async thread => {
    const question = states.get(asked.get(thread.id) ?? '') ?? null
    // The list and detail share the owner's host-confirmed wake projection;
    // the queued run and its committed answer remain unchanged.
    const questionWake = thread.ownedByCurrentUser && question === 'resuming' && (thread.continuation?.status ?? thread.status) === 'queued'
      ? await (await import('@/lib/factory/questions/wake')).questionWakeFailure(pool, viewerId, thread.latestRunId)
      : null
    return { ...thread, question, questionWake }
  })), deadline }
}

/** Shared with the explicit owner Retry action: a check can recover its own
 * strict question, never become an ordinary task continuation. */
async function originalSessionRetry(userId: string, runId: string, issueId: string) {
  const requestId=factoryEventId('question-owner-retry',runId)
  const eventId=factoryEventId('question-recover',requestId)
  const {rows:[question]}=await pool.query(`SELECT q.id AS "questionId",q.revision AS "questionRevision",
    q.status AS "questionStatus",q."continuationRunId",q."originRunId",q."originSessionId",t."botId",t.status AS "taskStatus",r.status AS "runStatus",
    jsonb_build_object('taskId',t.id,'issueId',t."issueId",'attemptId',t."attemptId",'candidateId',t."candidateId",'revision',t.revision) AS binding,
    e.request AS "recoveryRequest"
    FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=$1
    JOIN agent_runs r ON r.id=$2 AND r."userId"=$1 AND r."issueId"=$3
    LEFT JOIN factory_events e ON e."taskId"=t.id AND e."eventId"=$4 AND e.request->>'kind'='question_recover'
      AND e.request->>'userId'=$1 AND e.request->'input'->>'expectedFailedRunId'=r.id::text
      AND e.request->'input'->'reference'->>'questionId'=q.id::text
    WHERE q."userId"=$1 AND q."issueId"=$3 AND t."issueId"=$3
      AND r."questionContinuation"->>'requireSessionResume'='true'
      AND (q."continuationRunId"=r.id OR e."eventId" IS NOT NULL OR q.id::text=r."questionContinuation"->>'questionId')`,[userId,runId,issueId,eventId])
  return { requestId, question }
}

function originalSessionRetryAvailable(question: { recoveryRequest?: unknown; questionStatus: string; taskStatus: string; runStatus: string; continuationRunId: string | null } | undefined, runId: string) {
  return !!question && (!!question.recoveryRequest || (question.questionStatus === 'blocked' && question.taskStatus === 'blocked' && question.runStatus === 'failed' && question.continuationRunId === runId))
}

/**
 * Where a thread runs, for the run-location icon after its title
 * (docs/design/thread-run-location.md). Only the thread's owner sees which
 * machine; anyone else who may read the thread gets null. Its own read, so the
 * conversation's frequent reads never wait on a device's presence.
 */
export async function getThreadMachine(issueId: string | null, runId: string): Promise<import('@/lib/thread-machine').ThreadMachine | null> {
  return withDatabaseOperation('/actions/threads/machine', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    return (await import('@/lib/thread-machine-view')).readThreadMachine(pool, user.id, runIds)
  })
}

/**
 * The thread summary header read (#2935): machine {kind,size,state}, repository,
 * branch, and context used with its real model-catalog limit. Owner-only like
 * getThreadMachine; cost waits on its source (A) and returns null until it lands.
 */
export async function getThreadSummary(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/summary', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const latestRunId = chain?.latestRunId ?? row.id
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    const [{ readThreadMachine }, { readThreadLocation }] = await Promise.all([
      import('@/lib/thread-machine-view'), import('@/lib/thread-summary')])
    const [machine, context, location] = await Promise.all([
      readThreadMachine(pool, user.id, runIds),
      readContextUsage(runIds, row.id, latestRunId),
      readThreadLocation(pool, user.id, latestRunId)])
    const { catalogIdFor, catalogModel } = await import('@/lib/model-catalog')
    // The current attempt's model decides the window: after a continuation
    // changes models, context.model is still the frozen original's.
    const windowModel = context.composerModel?.served ?? context.composerModel?.selected ?? context.model
    const windowTokens = windowModel
      ? catalogModel(catalogIdFor(windowModel) ?? windowModel)?.contextWindow ?? null
      : null
    return {
      cost: null,
      machine: machine ? { kind: machine.kind, size: location.machineSize, state: machine.state } : null,
      repository: location.repository,
      branch: location.branch,
      context: { ...context, windowTokens },
    }
  })
}

/**
 * What this thread's run holds (lib/context-usage.ts). One query counts every
 * character in SQL and returns no text: a cursor read must stay small, so the
 * brief cannot be sent again to be measured (tests/thread-detail-bytes.db.test.ts).
 * It covers the whole run chain and the whole stored brief whatever the cursor
 * returned, so a cursor read reports the same usage as a full one.
 */
async function readContextUsage(runIds: string[], rootRunId: string, latestRunId: string): Promise<import('@/lib/context-usage').ContextUsage> {
  const { CONTEXT_CHARS_SQL, contextUsageFromCounts } = await import('@/lib/context-usage')
  const { rows: [counted] } = await pool.query<Record<string, string | number | null>>(CONTEXT_CHARS_SQL, [runIds, rootRunId, latestRunId])
  const count = (value: unknown) => Number(value ?? 0) || 0
  const counts = (ascii: unknown, other: unknown) => ({ ascii: count(ascii), other: count(other) })
  return contextUsageFromCounts({
    prompt: counts(counted?.promptAscii, counted?.promptOther),
    // The task range is sliced in SQL by the recorded code points, and is empty
    // when the range does not hold (lib/thread-prompt.ts rejects it there).
    task: counts(counted?.taskAscii, counted?.taskOther),
    messages: counts(counted?.messageAscii, counted?.messageOther),
    conversation: counts(counted?.conversationAscii, counted?.conversationOther),
    ...(typeof counted?.selectedModel === 'string' || typeof counted?.servedModel === 'string' ? { composerModel: {
      selected: typeof counted?.selectedModel === 'string' ? counted.selectedModel : null,
      served: typeof counted?.servedModel === 'string' ? counted.servedModel : null,
    } } : {}),
    model: typeof counted?.model === 'string' ? counted.model : null,
  })
}

/** Load the whole-history estimate after the conversation's first page. */
export async function getIssueThreadContext(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/context', async () => {
    const { row } = await readableThread(issueId, runId, threadIdentityColumns)
    const chain = await readRunChain(pool, row.userId, row.id)
    return readContextUsage(chain?.attempts.map(attempt => attempt.runId) ?? [row.id], row.id, chain?.latestRunId ?? row.id)
  })
}

async function readThreadComposerModel(runId: string) {
  const { threadModelProjection } = await import('@/lib/context-usage')
  const { rows: [model] } = await pool.query<{ selectedModel: string | null; servedModel: string | null }>(
    `SELECT ${threadModelProjection} FROM agent_runs latest WHERE latest.id=$1`, [runId])
  return model?.selectedModel || model?.servedModel ? { selected: model.selectedModel, served: model.servedModel } : undefined
}

async function readThreadMessages(runIds: string[], viewerId: string, ids?: string[]): Promise<IssueThreadDetail['messages']> {
  if (ids && !ids.length) return []
  const messages = await db.select({ id: runMessages.id, sourceRunId:runMessages.runId, editable:sql<boolean>`${runMessages.origin}='owner' AND ${runMessages.deliveredAt} IS NOT NULL AND failure IS NULL`,
      submissionId: sql<string | null>`${coordinatorEvents.payload}#>>'{threadSubmission,requestId}'`,
      text: runMessages.text, at: runMessages.createdAt, userId: runMessages.userId, name: users.name, email: users.email, image: users.image })
      .from(runMessages).leftJoin(users, eq(users.id, runMessages.userId))
      .leftJoin(coordinatorEvents, and(eq(coordinatorEvents.id, runMessages.id), eq(coordinatorEvents.userId, viewerId), eq(coordinatorEvents.kind, 'user_message')))
      .where(ids ? and(inArray(runMessages.runId, runIds), inArray(runMessages.id, ids)) : inArray(runMessages.runId, runIds))
      .orderBy(asc(runMessages.createdAt), asc(runMessages.id))
  return messages.map(message => ({
    id: message.id, sourceRunId: message.sourceRunId, editable: message.editable && message.userId === viewerId,
    ...(message.submissionId ? { submissionId: message.submissionId } : {}), text: message.text, at: message.at,
    author: message.name || message.email || '', image: message.image ?? null, mine: message.userId === viewerId,
  }))
}

async function readPagedThreadMessages(runIds: string[], viewerId: string, ids: string[], append: boolean) {
  if (!append) return { messages: await readThreadMessages(runIds, viewerId, ids), messageUpdates: undefined }
  // Delivery can turn a rendered message into an editable one without creating an event.
  const newest = await db.select({ id: runMessages.id }).from(runMessages).where(inArray(runMessages.runId, runIds))
    .orderBy(desc(runMessages.createdAt), desc(runMessages.id)).limit(32)
  const all = await readThreadMessages(runIds, viewerId, [...new Set([...ids, ...newest.map(row => row.id)])])
  const added = new Set(ids)
  return { messages: all.filter(row => added.has(row.id)), messageUpdates: all.filter(row => !added.has(row.id)) }
}

/** Read older events through the same authorized run and its current chain. */
export async function getOlderIssueThread(issueId: string | null, runId: string, before: ThreadHistoryPosition) {
  return withDatabaseOperation('/actions/threads/history', async () => {
    const position = threadHistoryPosition.parse(before)
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    const chain = await readRunChain(pool, row.userId, row.id)
    const from = chain ? Math.max(0, chain.attempts.findIndex(attempt => attempt.runId === row.id)) : 0
    const runIds = chain ? chain.attempts.slice(from).map(attempt => attempt.runId) : [row.id]
    if (!runIds.includes(position.runId)) throw new ActionFailureError('runNotFound')
    const page = await readThreadHistory(runIds, 'before', position)
    return { chain: runIds.join(','), before: page.more ? page.earliest : null, chunks: page.chunks,
      messages: await readThreadMessages(runIds, user.id, page.messageIds) }
  })
}

/** One thread as a conversation: what it was asked, what the agent did, and what people said in it. */
export async function getIssueThread(issueId: string | null, runId: string, after?: ThreadChunkCursor | ThreadHistoryInput | null): Promise<IssueThreadDetail> {
  return withDatabaseOperation('/actions/threads/detail', () => readIssueThread(issueId, runId, after))
}

async function readIssueThread(issueId: string | null, runId: string, after?: ThreadChunkCursor | ThreadHistoryInput | null): Promise<IssueThreadDetail> {
  const history = after && 'kind' in after ? threadHistoryInput.parse(after) : null
  const cursor = after && !history ? threadChunkCursor.parse(after) : null
  const resuming = Boolean(cursor || history?.after)
  // Before any of the thread: this run's keys' revisions (other attempts carry none, so they always read).
  const { readRevisions } = await import('@/lib/live/revision-read')
  const revisions = await readRevisions([{ kind: 'thread', id: runId }, { kind: 'run', id: runId }])
  const { row, user } = resuming ? await readableThread(issueId, runId, threadCursorColumns) : await readableThread(issueId, runId, threadColumns)
  // The run that resumes this one after an answered question, or runs it again after it ended (R-81), is the same thread: its chain (BE-18).
  // Named by its task, not by system text prepended to the prompt (lib/thread-prompt.ts); a cursor read's prompt is already its name lines.
  const named = resuming ? row : { ...row, prompt: threadPromptView(row.prompt, row.promptTaskStart, row.promptTaskLength).task }
  const [projected] = projectIssueThreads([named], row.issueId, user.id, new Set([user.id]))
  const chain = projected ? await readRunChain(pool, row.userId, row.id) : null
  // The conversation is the thread's, across its runs from this one on, oldest first.
  const from = chain ? Math.max(0, chain.attempts.findIndex(attempt => attempt.runId === row.id)) : 0
  const runIds = chain ? chain.attempts.slice(from).map(attempt => attempt.runId) : [row.id]
  // Invalidation reads retain the cursor: only later chunks, not the whole chain again.
  // Capture exactly what this read could display. An arriving reply after this
  // point stays unread until a subsequent transcript is visible.
  const readReceipts = await threadReadReceipts(user.id, runIds)
  const [transcript, { threads: [thread], deadline: questionDeadline }] = await Promise.all([
    history ? readLatestThreadHistory(runIds, history.after).then(async page => ({
      chunks: page.chunks, cursor: null, append: false, historyPage: page.historyPage,
      ...await readPagedThreadMessages(runIds, user.id, page.messageIds, page.historyPage.append),
    })) : Promise.all([readThreadChunks(runIds, cursor), readThreadMessages(runIds, user.id)])
      .then(([read, messages]) => ({ ...read, messages, messageUpdates: undefined, historyPage: undefined })),
    projected ? threadQuestions([withRunChain(projected, chain)], user.id) : { threads: [], deadline: null },
  ])
  const { chunks, messages, messageUpdates, historyPage } = transcript
  // The client keeps its held prompt only when it keeps its held chunks; any other read sends the whole prompt.
  const promptOmitted = resuming && (historyPage?.append ?? transcript.append)
  const stored = resuming && !promptOmitted ? (await db.select({ prompt: agentRuns.prompt, promptTaskStart: agentRuns.promptTaskStart, promptTaskLength: agentRuns.promptTaskLength }).from(agentRuns).where(eq(agentRuns.id, row.id)).limit(1))[0] ?? { prompt: '', promptTaskStart: null, promptTaskLength: null } : row
  // The thread shows the task it was given; the Agent's full instructions open on request (getThreadInstructions).
  const { task: prompt, hasInstructions } = threadPromptView(stored.prompt, stored.promptTaskStart, stored.promptTaskLength)
  if (!thread) throw new ActionFailureError('runNotFound')
  // A stop request belongs to the live run that send and stop address, not to an earlier attempt.
  const live = chain?.attempts.find(attempt => attempt.runId === thread.latestRunId)
  const stopRequestedAt = live && live.runId !== row.id ? live.stopRequestedAt : row.stopRequestedAt
  // Failure and Retry address that same run. Keep the root's name, prompt and
  // identity while reading the latest failed continuation's masked error.
  let error: string | null = null
  let failureDetails = readRunFailure(live && live.runId !== row.id ? live.failureDetails : row.failureDetails)
  if ((live?.status ?? row.status) === 'failed') {
    if (!live || live.runId === row.id) error = row.error ?? null
    else {
      const [failed] = await db.select({ error: agentRuns.error, failureDetails: agentRuns.failureDetails }).from(agentRuns)
        .where(and(eq(agentRuns.id, live.runId), eq(agentRuns.userId, row.userId),
          row.issueId === null ? isNull(agentRuns.issueId) : eq(agentRuns.issueId, row.issueId), eq(agentRuns.status, 'failed'))).limit(1)
      error = failed?.error ?? null
      failureDetails = readRunFailure(failed?.failureDetails)
    }
  }
  const questionWake = thread.questionWake ?? null
  if (questionWake) error = questionWake.error
  const liveStatus = live?.status ?? row.status
  let replyAvailable = true
  let retryAvailable = !!questionWake || liveStatus === 'failed'
  if (!runIsActive(liveStatus)) {
    // Independent checks cannot enter ordinary continuation (latestTaskRun).
    // Read the latest run's host binding, never a report or the root's stage.
    const { rows: [target] } = await pool.query<{ independentCheck: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM factory_attempts a WHERE a."runId"=r.id AND a.stage IN ('review','verify','monitor')
      ) AS "independentCheck" FROM agent_runs r
      WHERE r.id=$1 AND r."userId"=$2 AND r."issueId" IS NOT DISTINCT FROM $3::uuid`, [thread.latestRunId, user.id, row.issueId])
    replyAvailable = !!target && (!target.independentCheck || thread.question === 'waiting')
    if (!target) retryAvailable = false
    else if (target.independentCheck) {
      const recovery = liveStatus === 'failed' && row.issueId
        ? await originalSessionRetry(user.id, thread.latestRunId, row.issueId) : null
      retryAvailable = originalSessionRetryAvailable(recovery?.question, thread.latestRunId)
    }
  }
  const [{ threadLiveReferences, documentLiveWorkspace }, { workspacePool }] = await Promise.all([import('@/lib/live/panels'), import('@/lib/workspace-db')])
  const chainRunIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
  const quotaView = row.userId === user.id ? import('@/lib/run-quota-view') : null
  const [runs, issueWorkspaceId, context, composerModel, delivery, quota, modelFallback] = await Promise.all([
    threadLiveReferences(pool, workspacePool, runIds, user.id),
    row.issueId ? documentLiveWorkspace(pool, workspacePool, row.issueId, user.id) : null,
    // Over the whole chain and the whole brief, so a cursor read reports what a full one does.
    history ? undefined : readContextUsage(chainRunIds, row.id, chain?.latestRunId ?? row.id),
    history ? readThreadComposerModel(thread.latestRunId) : undefined,
    row.userId === user.id ? import('@/lib/thread-delivery-queue').then(({ threadDeliveryView }) =>
      threadDeliveryView(pool, user.id, chain?.rootRunId ?? row.id, thread.latestRunId)) : undefined,
    quotaView?.then(({ threadQuotaView }) => threadQuotaView(user.id, chainRunIds, thread.latestRunId)),
    quotaView?.then(({ threadModelFallbackState }) => threadModelFallbackState(user.id, chainRunIds, thread.latestRunId)),
  ])
  return {
    readReceipts,
    delivery,
    live: { viewerId: user.id, runs, issueWorkspaceId, questionDeadline, ...(Object.keys(revisions).length ? { revisions } : {}) },
    thread: { ...thread, failureDetails, questionWake, prompt: promptOmitted ? '' : prompt, ...(!promptOmitted && hasInstructions ? { hasInstructions: true as const } : {}), stopRequestedAt, replyAvailable, retryAvailable, quota: quota ?? null, modelFallback: modelFallback?.notices ?? null, modelFallbackPending: modelFallback?.pending ?? false, error, feedbackEligible: row.userId===user.id && ['succeeded','failed'].includes(row.status) && !!row.finishedAt && !!row.sessionId && !!row.deviceRepoId },
    chunks,
    messages,
    chunkCursor: transcript.cursor,
    chunksAppend: transcript.append,
    ...(historyPage ? { historyPage } : {}),
    ...(messageUpdates?.length ? { messageUpdates } : {}),
    context,
    ...(composerModel ? { composerModel } : {}),
    ...(promptOmitted ? { promptOmitted: true as const } : {}),
  }
}

/** Everything the thread's Agent was sent, for 查看完整指令: read only when the person asks for it. */
export async function getThreadInstructions(issueId: string | null, runId: string): Promise<string> {
  return withDatabaseOperation('/actions/threads/instructions', async () => {
    const { row } = await readableThread(issueId, runId, threadIdentityColumns)
    return (await db.select({ prompt: agentRuns.prompt }).from(agentRuns).where(eq(agentRuns.id, row.id)).limit(1))[0]?.prompt ?? ''
  })
}

/**
 * The thread's 改动 tab (Figma 820:4843): the newest checkpoint of its run chain, a
 * gzipped `git diff --binary` with secrets already masked when it was saved
 * (app/v1/runs/[runId]/checkpoint). Read-only; whoever may read the thread sees it.
 */
export async function getThreadChanges(issueId: string | null, runId: string): Promise<ThreadChangesResult> {
  return withDatabaseOperation('/actions/threads/changes', () => readThreadChanges(issueId, runId))
}

async function readThreadChanges(issueId: string | null, runId: string): Promise<ThreadChangesResult> {
  const { row } = await readableThread(issueId, runId, threadIdentityColumns)
  const { runIds, checkpoint } = await readRunChainCheckpoint(pool, row.userId, row.id)
  if (!checkpoint) return { state: 'none' }
  if (checkpoint.unavailableReason) return { state: 'tooLarge' }
  let text: string
  try { text = gunzipSync(checkpoint.patch, { maxOutputLength: THREAD_CHANGES_MAX_TEXT }).toString('utf8') } catch { return { state: 'tooLarge' } }
  const changes = parseUnifiedDiff(text)
  if (!changes.files.length) return { state: 'none' }
  // 在新标签打开: the file in the thread's pull request, on GitHub's files page.
  const { rows: [published] } = await pool.query<{ url: string }>(
    `SELECT "pullRequest"->>'url' AS url FROM run_publications WHERE "runId"=ANY($1::uuid[]) AND "pullRequest"->>'url' IS NOT NULL ORDER BY "updatedAt" DESC LIMIT 1`, [runIds])
  const prUrl = published && safeHttpUrl(published.url)
  if (prUrl) for (const file of changes.files) file.url = `${prUrl.replace(/\/+$/, '')}/files#diff-${createHash('sha256').update(file.path).digest('hex')}`
  return { state: 'ready', changes }
}

const THREAD_CHANGES_MAX_TEXT = 8 * 1024 * 1024

function safeHttpUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : null } catch { return null }
}

/** Something a person says in a running thread; the daemon delivers it to the agent. */
export async function sendIssueThreadMessage(input: { issueId: string | null; runId: string; text: string; requestId?: string; modelChoice?: ThreadModelChoice; delivery?: import('@/lib/thread-delivery').ThreadDeliveryMode; expectedOwnerId?: string; expectedWorkspaceId?: string; retryOriginalSession?: true; questionWakeGeneration?: string; references?: import('@/lib/thread-references-server').ThreadReference[] }): Promise<{ runId: string; continued: boolean }> {
  const text = z.string().trim().min(1).max(10_000).safeParse(input.text)
  if (!text.success) throw new ActionFailureError('messageRequired')
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  const requestHeaders=await headers()
  if(!desktopHumanSessionId()&&(requestHeaders.has('authorization')||!requestHeaders.get('cookie')))throw new ActionFailureError('authRequired')
  const session=await auth.api.getSession({headers:requestHeaders,query:{disableCookieCache:true}})
  if(!session?.user||!session.session?.id||session.user.id!==user.id)throw new ActionFailureError('authRequired')
  if (input.expectedOwnerId && session.user.id !== input.expectedOwnerId) throw new ActionFailureError('authRequired')
  if (input.expectedWorkspaceId && (await loadWorkspaceContext(undefined, session.user)).workspace.id !== input.expectedWorkspaceId) throw new ActionFailureError('workspaceAccessDenied')
  if(row.userId!==user.id)throw new ActionFailureError('runNotFound')
  if(input.retryOriginalSession!==undefined && input.retryOriginalSession!==true)throw new ActionFailureError('runInvalid')
  if (input.delivery !== undefined && (!['queue','steer','interrupt'].includes(input.delivery) || !input.requestId || input.retryOriginalSession)) throw new ActionFailureError('validationGeneric')
  if(input.requestId!==undefined && !z.uuid().safeParse(input.requestId).success)throw new ActionFailureError('validationGeneric')
  if(input.modelChoice !== undefined && (input.retryOriginalSession || !input.requestId || !threadModelChoice.safeParse(input.modelChoice).success))throw new ActionFailureError('validationGeneric')
  if(input.requestId!==undefined && input.retryOriginalSession)throw new ActionFailureError('validationGeneric')
  if(input.questionWakeGeneration!==undefined && (!input.retryOriginalSession || !z.uuid().safeParse(input.questionWakeGeneration).success))throw new ActionFailureError('validationGeneric')
  if(input.questionWakeGeneration!==undefined) {
    if(!row.issueId)throw new ActionFailureError('threadCannotContinue')
    try {
      const {retryQueuedQuestionWake}=await import('@/lib/factory/questions/wake')
      return await retryQueuedQuestionWake(pool,{userId:user.id,sessionId:session.session.id},row.id,input.questionWakeGeneration)
    } catch(error) {
      if(error instanceof FactoryError)throw new ActionFailureError(error.code==='factoryNotFound'?'runNotFound':'threadRecoveryUnavailable')
      throw error
    }
  }
  if(input.retryOriginalSession && row.issueId) {
    // Only the existing owner Retry control requests recovery. A typed label,
    // Bot message or ordinary send never acquires this authority.
    const { requestId, question } = await originalSessionRetry(user.id, row.id, row.issueId)
    if(question) {
      if(!originalSessionRetryAvailable(question, row.id))throw new ActionFailureError('threadCannotContinue')
      // One SQL snapshot selects either the original receipt input or the
      // current reference. Concurrent clicks therefore send the same request.
      const input=question.recoveryRequest?.input ?? {requestId,expectedFailedRunId:row.id,reference:{questionId:question.questionId,questionRevision:question.questionRevision,binding:question.binding,originRunId:question.originRunId,originSessionId:question.originSessionId}}
      try {
        const {factoryRuntimeForBot}=await import('@/lib/factory/runtime')
        const recovered=await factoryRuntimeForBot(question.botId).questions.recover({source:'human',userId:user.id,sessionId:session.session.id},input)
        return {runId:recovered.continuationRunId,continued:true}
      } catch(error) {
        if(error instanceof FactoryError)throw new ActionFailureError(error.code==='factoryNotFound'?'runNotFound':'threadRecoveryUnavailable')
        throw error
      }
    }
  }
  let body = text.data
  if (input.references?.length) {
    const refs = z.array((await import('@/lib/thread-references-server')).threadReference).max(20).safeParse(input.references)
    if (!refs.success) throw new ActionFailureError('validationGeneric')
    const resolved = await (await import('@/lib/thread-references-server')).resolveThreadReferences(pool, user.id, row.workspaceId ?? null, refs.data)
    body = (await import('@/lib/thread-references-server')).expandReferences(resolved) + body
    if (body.length > 10_000) throw new ActionFailureError('messageRequired')
  }
  // A working thread gets it as a message; an ended one runs again in the same thread (R-81, lib/thread-continue.ts).
  return sendThreadMessage(user.id,row.id,body,{source:'human',sessionId:session.session.id},input.requestId,input.delivery,input.modelChoice)
}

/** #2941 item 3: preview cards for the composer's typed references. Same
 * resolution the send runs; never throws per reference. */
export async function getReferencePreview(input: { issueId: string | null; runId: string; references: import('@/lib/thread-references-server').ThreadReference[] }) {
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  const refs = z.array((await import('@/lib/thread-references-server')).threadReference).max(20).safeParse(input.references)
  if (!refs.success) throw new ActionFailureError('validationGeneric')
  return { references: await (await import('@/lib/thread-references-server')).resolveThreadReferences(pool, user.id, row.workspaceId ?? null, refs.data) }
}

/** #2941 item 4: a side note stored in the thread that does NOT wake the
 * agent — the daemon reads it as context on the next ordinary turn. */
export async function btwIssueThreadMessage(input: { issueId: string | null; runId: string; text: string }) {
  const text = z.string().trim().min(1).max(10_000).safeParse(input.text)
  if (!text.success) throw new ActionFailureError('messageRequired')
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id) throw new ActionFailureError('runNotFound')
  const { db } = await import('@/lib/db')
  const { runMessages } = await import('@/lib/db/schema')
  const { MAILBOX_NOTIFICATION_LIMIT } = await import('@/lib/mailbox-notification-budget')
  const { personalRunMessageText } = await import('@/lib/personal-run-message')
  const id = crypto.randomUUID()
  await db.transaction(async tx => {
    await tx.insert(runMessages).values({ id, runId: row.id, userId: user.id,
      text: personalRunMessageText(id, `/btw ${text.data}`, 'user'), origin: 'peer',
      mailboxWakeDepth: MAILBOX_NOTIFICATION_LIMIT })
  })
  return { stored: true }
}

/** #2941 item 4: context stats consistent with the summary read (same
 * conversationUsage module). `compact` asks the agent to fold now via a
 * waking peer directive. */
export async function getThreadContextStats(input: { issueId: string | null; runId: string }) {
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id) throw new ActionFailureError('runNotFound')
  const { readRunChain } = await import('@/lib/run-chain')
  const chain = await readRunChain(pool, user.id, row.id)
  return { usage: await readContextUsage(chain?.attempts.map(a => a.runId) ?? [row.id], chain?.rootRunId ?? row.id, chain?.latestRunId ?? row.id) }
}
export async function compactThread(input: { issueId: string | null; runId: string }) {
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id) throw new ActionFailureError('runNotFound')
  const { addRunMessage } = await import('@/lib/agent-runs')
  await addRunMessage(user.id, { runId: row.id, text: '/compact — fold the working context now.' }, 'peer')
  return { requested: true }
}

/** #2941 item 5: thread-scoped env vars — names only, values never read back. */
export async function listThreadEnvVars(input: { issueId: string | null; runId: string }) {
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id || !row.workspaceId) throw new ActionFailureError('runNotFound')
  const { readRunChain } = await import('@/lib/run-chain')
  const scopeRef = (await readRunChain(pool, user.id, row.id))?.rootRunId ?? row.id
  const { rows } = await pool.query<{ id: string; name: string; note: string; updatedAt: Date }>(
    `SELECT id,name,note,"updatedAt" FROM workspace_secrets WHERE "workspaceId"=$1 AND "scopeType"='thread' AND "scopeRef"=$2 ORDER BY name`,
    [row.workspaceId, scopeRef])
  return { env: rows.map(r => ({ id: r.id, name: r.name, note: r.note, updatedAt: r.updatedAt })) }
}
export async function setThreadEnvVar(input: { issueId: string | null; runId: string; name: string; value: string }) {
  const name = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256).safeParse(input.name)
  const value = z.string().min(1).max(8192).safeParse(input.value)
  if (!name.success || !value.success) throw new ActionFailureError('validationGeneric')
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id || !row.workspaceId) throw new ActionFailureError('runNotFound')
  const { readRunChain } = await import('@/lib/run-chain')
  const scopeRef = (await readRunChain(pool, user.id, row.id))?.rootRunId ?? row.id
  const { setThreadScopeSecret } = await import('@/lib/secrets/thread-scope')
  return { env: await setThreadScopeSecret(user.id, row.workspaceId, scopeRef, { name: name.data, value: value.data }) }
}
export async function deleteThreadEnvVar(input: { issueId: string | null; runId: string; name: string }) {
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id || !row.workspaceId) throw new ActionFailureError('runNotFound')
  const { readRunChain } = await import('@/lib/run-chain')
  const scopeRef = (await readRunChain(pool, user.id, row.id))?.rootRunId ?? row.id
  const { deleteThreadScopeSecret } = await import('@/lib/secrets/thread-scope')
  await deleteThreadScopeSecret(user.id, row.workspaceId, scopeRef, input.name)
  return { deleted: true }
}

/** #2941 item 6: @-mentioning a bot in a thread dispatches the note to that
 * bot's own thread — a coordinator event in its inbox (same shape sendToBot
 * uses for interop peers) plus the wake that starts its turn. */
export async function mentionThreadBot(input: { issueId: string | null; runId: string; botId: string; text: string }) {
  const text = z.string().trim().min(1).max(10_000).safeParse(input.text)
  const botId = z.uuid().safeParse(input.botId)
  if (!text.success || !botId.success) throw new ActionFailureError('validationGeneric')
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  if (row.userId !== user.id || !row.workspaceId) throw new ActionFailureError('runNotFound')
  const { rows: [bot] } = await pool.query<{ id: string; ownerId: string }>(
    `SELECT id,"ownerId" FROM bots WHERE id=$1 AND "workspaceId"=$2`, [botId.data, row.workspaceId])
  if (!bot) throw new ActionFailureError('botNotFound')
  // A mention starts the bot's turn; require canSteer on the bot, as sendToBot does.
  const { resourceActionAllowed } = await import('@/lib/resource-access/store')
  if (!await resourceActionAllowed(db, user.id, { kind: 'bot', id: bot.id, workspaceId: row.workspaceId }, 'canSteer'))
    throw new ActionFailureError('botNotFound')
  const { rows: [inserted] } = await pool.query<{ id: string }>(
    `INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier)
     VALUES ($1,$2,$3,'run_report',$4,$5,'result') ON CONFLICT ("dedupeKey") DO NOTHING RETURNING id`,
    [crypto.randomUUID(), bot.ownerId, bot.id, `mention:${user.id}:${bot.id}:${row.id}:${crypto.randomUUID()}`,
     JSON.stringify({ text: text.data, source: 'peer', from: { kind: 'user', id: user.id }, threadRunId: row.id })])
  if (inserted) {
    const { wakeCoordinator } = await import('@/lib/coordinator/wake')
    await wakeCoordinator(bot.ownerId)
  }
  return { dispatched: true, eventId: inserted?.id ?? null }
}

/**
 * The composer's send: the same as sendIssueThreadMessage, with a refusal the
 * person can act on (threadReplaced, threadCannotContinue, threadStopping, a
 * dispatch with no machine or model) returned as its code, so the thread says
 * why instead of 「发送失败」. Other failures still throw.
 */
export async function sendIssueThreadReply(input: { issueId: string | null; runId: string; text: string; requestId?: string; modelChoice?: ThreadModelChoice; delivery?: import('@/lib/thread-delivery').ThreadDeliveryMode; expectedOwnerId?: string; expectedWorkspaceId?: string; retryOriginalSession?: true; questionWakeGeneration?: string }): Promise<ActionResult<{ sent: true; runId: string; continued: boolean }>> {
  return runAction(async () => { const result=await sendIssueThreadMessage(input); return { sent: true as const,...result } })
}

export async function createThreadReplyVersion(input: { issueId: string | null; runId: string; change: import('@/lib/thread-reply-versions').ReplyVersionInput }) {
  return runAction(async () => {
    const { row,user } = await readableThread(input.issueId,input.runId,threadColumns)
    const requestHeaders = await headers()
    if (!desktopHumanSessionId() && (requestHeaders.has('authorization') || !requestHeaders.get('cookie'))) throw new ActionFailureError('authRequired')
    const session = await auth.api.getSession({headers:requestHeaders,query:{disableCookieCache:true}})
    if (!session?.session?.id || session.user.id !== user.id || row.userId !== user.id) throw new ActionFailureError('runNotFound')
    return (await import('@/lib/thread-reply-versions')).createReplyVersion(pool,user.id,row.id,input.change)
  })
}

export async function getThreadReplyVersions(issueId:string|null,runId:string) {
  const { row,user } = await readableThread(issueId,runId,threadColumns)
  if (row.userId !== user.id) throw new ActionFailureError('runNotFound')
  return (await import('@/lib/thread-reply-versions')).readReplyVersions(pool,user.id,row.id)
}

export async function changeQueuedThreadReply(input: { issueId: string | null; runId: string; messageId: string; action: 'cancel' | 'sendNow' | 'edit'; text?: string }) {
  return runAction(async () => {
    if (!z.uuid().safeParse(input.messageId).success || !['cancel','sendNow','edit'].includes(input.action)
        || (input.action === 'edit' && !z.string().min(1).max(10_000).safeParse(input.text).success)) throw new ActionFailureError('validationGeneric')
    const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
    const requestHeaders = await headers()
    if (!desktopHumanSessionId() && (requestHeaders.has('authorization') || !requestHeaders.get('cookie'))) throw new ActionFailureError('authRequired')
    const session = await auth.api.getSession({ headers: requestHeaders, query: { disableCookieCache: true } })
    if (!session?.session?.id || session.user.id !== user.id || row.userId !== user.id) throw new ActionFailureError('runNotFound')
    const { cancelQueuedThreadReply, deliverQueuedThreadReply, editQueuedThreadReply } = await import('@/lib/thread-delivery-queue')
    if (input.action === 'cancel') return { status: await cancelQueuedThreadReply(pool, user.id, row.id, input.messageId) }
    if (input.action === 'edit') {
      const text = typeof input.text === 'string' ? input.text : ''
      if (!text.trim() || text.length > 10000) return { status: 'invalid' as const }
      return { status: await editQueuedThreadReply(pool, user.id, row.id, input.messageId, text) }
    }
    return { status: await deliverQueuedThreadReply(pool, user.id, row.id, input.messageId) ? 'sent' as const : 'tooLate' as const }
  })
}

export async function getThreadContinuationModels(issueId: string, runId: string) {
  const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
  if (row.userId !== user.id) throw new ActionFailureError('runNotFound')
  const { threadModelMenu } = await import('@/lib/thread-model-menu')
  const reader = await getWorkspaceReader()
  if (reader.id !== user.id) throw new ActionFailureError('runNotFound')
  return threadModelMenu(reader, reader[tokenWorkspace], issueId, row.id)
}

/**
 * A thread's name: the task it works on, as "MIK-11 群聊建表" (glossary:
 * a thread is one run, named for its work, never for its bot). Null when the
 * run is not this person's or works on no task.
 */
/** A run's sub-agent cards (#2939): the parent's children with name, mark, brief and live state. */
export async function listSubagentRuns(runId: string) {
  const reader = await getWorkspaceReader()
  return (await import('@/lib/subagent-runs')).listSubagentRuns(reader, runId)
}

export async function getThreadName(runId: string): Promise<string | null> {
  const reader = await getWorkspaceReader()
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) return null
  const source = (await citationSources(reader, [`[[run:${parsed.data}]]`]))[parsed.data]
  if (source?.kind !== 'run' || !source.issue) return null
  const key = source.issue.identifier ?? (source.issue.number === null ? null : `#${source.issue.number}`)
  return key ? `${key} ${source.issue.title}` : source.issue.title
}




/** #2940 items 1/4: review sessions minted on the thread's own machine —
 * terminal (item 1, several per machine via the named-session key) and the
 * user-facing preview browser (item 4, short-lived ticket through the same
 * gateway). Task-scoped authority: only a thread bound to a task exposes a
 * machine review capability at all. */
async function threadSessionAuthority(issueId: string | null, runId: string) {
  const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
  if (row.userId !== user.id || !issueId) return null
  const [{ getApiSession }, { workspacePool }, { resolveTaskReviewAuthority }] = await Promise.all([
    import('@/lib/api-auth'), import('@/lib/workspace-db'), import('@/lib/coding-workspace/review-authority')])
  const session = await getApiSession({ headers: await headers(), query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) throw new ActionFailureError('authRequired')
  // Fence every authority resolution to THIS thread's run — the resolver
  // otherwise selects the task's newest run and a control could reach a
  // different thread's machine (review_binding_changed denies instead).
  return { session, workspacePool, resolve: resolveTaskReviewAuthority, runId: row.id }
}

export async function listThreadReviewSessions(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/review-sessions', async () => {
    const ctx = await threadSessionAuthority(issueId, runId)
    if (!ctx) return null
    return ctx.resolve(pool, ctx.workspacePool, ctx.session, issueId!, { runId: ctx.runId }, async (authority, client) => {
      const { rows } = await client.query<{ id: string; kind: string; name: string; expiresAt: Date; createdAt: Date }>(
        `SELECT id,kind,name,"expiresAt","createdAt" FROM coding_review_sessions
          WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp()
          ORDER BY kind,name`, [authority.runId, authority.ownerId, authority.workspaceId])
      return rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString() }))
    })
  })
}

export async function openThreadTerminal(issueId: string | null, runId: string, input?: { name?: string }) {
  return withDatabaseOperation('/actions/threads/terminal/open', async () => {
    const ctx = await threadSessionAuthority(issueId, runId)
    if (!ctx) return null
    return ctx.resolve(pool, ctx.workspacePool, ctx.session, issueId!, { runId: ctx.runId }, async (authority, client) => {
      if (authority.machineKind !== 'cloud') throw new ActionFailureError('runNotFound')
      const { beginReviewSession } = await import('@/lib/coding-workspace/review-sessions')
      const lease = await beginReviewSession(authority, { kind: 'terminal', name: input?.name ?? '' }, client)
      return { id: lease.id, name: input?.name ?? '', expiresAt: lease.expiresAt }
    })
  })
}

export async function closeThreadTerminal(issueId: string | null, runId: string, input: { id: string; name?: string }) {
  return withDatabaseOperation('/actions/threads/terminal/close', async () => {
    const ctx = await threadSessionAuthority(issueId, runId)
    if (!ctx) return null
    // Confirm the lease inside the authority transaction, then release the
    // SQL locks before the provider close — the HTTP close handler's order.
    const authority = await ctx.resolve(pool, ctx.workspacePool, ctx.session, issueId!, { runId: ctx.runId },
      async (current, client) => {
        const { readReviewSession } = await import('@/lib/coding-workspace/review-sessions')
        const lease = await readReviewSession(current, { kind: 'terminal', id: input.id, name: input.name ?? '' }, client)
        if (!lease) return null
        return current
      })
    if (!authority) return { closed: false }
    const { revokeReviewSession } = await import('@/lib/coding-workspace/review-sessions')
    const result = await revokeReviewSession(authority, { kind: 'terminal', id: input.id })
    return { closed: !result.pending }
  })
}

export async function openThreadBrowser(issueId: string | null, runId: string, input?: { port?: number }) {
  return withDatabaseOperation('/actions/threads/browser/open', async () => {
    const ctx = await threadSessionAuthority(issueId, runId)
    if (!ctx) return null
    const session = ctx.session
    const { resolveTaskReviewAuthority } = await import('@/lib/coding-workspace/review-authority')
    const { beginReviewSession, readReviewSession, revokeReviewSession } = await import('@/lib/coding-workspace/review-sessions')
    const { resumeReviewMachine } = await import('@/lib/coding-workspace/review-machine')
    const { prepareRunPreview, issueRunPreview } = await import('@/lib/coding-workspace/preview/runtime')
    const { isPreviewPort } = await import('@/lib/coding-workspace/preview/port')
    const port = input?.port
    if (port !== undefined && !isPreviewPort(port)) throw new ActionFailureError('runNotFound')
    const parentOrigin = `https://${(await headers()).get('host')}`
    const signal = AbortSignal.timeout(50_000)
    let authority = await resolveTaskReviewAuthority(pool, ctx.workspacePool, session, issueId!, { runId: ctx.runId })
    const fence = () => ({ runId: authority.runId, bindingId: authority.bindingId })
    const lease = await resolveTaskReviewAuthority(pool, ctx.workspacePool, session, issueId!, fence(),
      async (current, client) => { authority = current; return beginReviewSession(current, { kind: 'preview' }, client) })
    try {
      await resumeReviewMachine(authority, lease, signal)
      const result = await prepareRunPreview(authority, { ...(port !== undefined ? { port } : {}), expiresAt: lease.expiresAt, ...(authority.sponsoredPlacement ? { lease } : {}) })
      if (!result.running) {
        await revokeReviewSession(authority, { kind: 'preview', id: lease.id })
        return { running: false as const }
      }
      const confirmed = await resolveTaskReviewAuthority(pool, ctx.workspacePool, session, issueId!, fence(),
        async (current, client) => { authority = current; return readReviewSession(current, { kind: 'preview', id: lease.id }, client) })
      if (!confirmed || confirmed.id !== lease.id) throw new ActionFailureError('runNotFound')
      const preview = await issueRunPreview(result, parentOrigin, { id: confirmed.id,
        expiresAt: new Date(Math.min(Date.parse(confirmed.expiresAt), Date.parse(result.expiresAt))).toISOString() })
      const still = await resolveTaskReviewAuthority(pool, ctx.workspacePool, session, issueId!, fence(),
        async (current, client) => readReviewSession(current, { kind: 'preview', id: lease.id }, client))
      if (!still) throw new ActionFailureError('runNotFound')
      return { id: lease.id, url: preview.url, expiresAt: lease.expiresAt }
    } catch (cause) {
      try { await revokeReviewSession(authority, { kind: 'preview', id: lease.id }) } catch { /* best effort */ }
      throw cause
    }
  })
}

export async function closeThreadBrowser(issueId: string | null, runId: string, input: { id: string }) {
  return withDatabaseOperation('/actions/threads/browser/close', async () => {
    const ctx = await threadSessionAuthority(issueId, runId)
    if (!ctx) return null
    const authority = await ctx.resolve(pool, ctx.workspacePool, ctx.session, issueId!, { runId: ctx.runId },
      async (current, client) => {
        const { readReviewSession } = await import('@/lib/coding-workspace/review-sessions')
        const lease = await readReviewSession(current, { kind: 'preview', id: input.id }, client)
        if (!lease) return null
        return current
      })
    if (!authority) return { closed: false }
    const { revokeReviewSession } = await import('@/lib/coding-workspace/review-sessions')
    const result = await revokeReviewSession(authority, { kind: 'preview', id: input.id })
    return { closed: !result.pending }
  })
}

/** #2940 item 2: uploads on the thread's chain, owner only. */
export async function listThreadUploads(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/uploads', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    return (await import('@/lib/thread-workspace')).listThreadUploads(pool, user.id, runIds)
  })
}

/** #2940 item 2: a fresh signed download URL for one of the thread's uploads. */
export async function getThreadUploadDownloadUrl(issueId: string | null, runId: string, fileId: string) {
  return withDatabaseOperation('/actions/threads/uploads/download', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    return (await import('@/lib/thread-workspace')).threadUploadDownloadUrl(pool, user.id, runIds, fileId)
  })
}

/** #2940 item 2: the files this thread changed, from the latest
 * coding-workspace diff snapshot per run. */
export async function listThreadChangedFiles(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/changed-files', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    return (await import('@/lib/thread-workspace')).listThreadChangedFiles(pool, user.id, row.workspaceId ?? null, runIds)
  })
}

/** #2940 item 3: the thread's machine — spec identity and liveness metrics. */
export async function getThreadMachineDetail(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/machine-detail', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    return (await import('@/lib/thread-workspace')).getThreadMachineDetail(pool, user.id, row.workspaceId ?? null, row.id)
  })
}

/** #2940 item 3: re-run setup/maintenance on the thread's machine — the
 * refresh_runtime the machine route already serves. */
export async function rerunThreadMachineSetup(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/machine-setup', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    return (await import('@/lib/thread-workspace')).rerunThreadMachineSetup(pool, user.id, row.workspaceId ?? null, row.id)
  })
}

/** #2926 composer machine menu: Sleep machine / Wake machine — the same
 * pause|resume the machine route serves, through threadMachineAction. */
export async function pauseOrResumeThreadMachine(issueId: string | null, runId: string, action: 'pause' | 'resume') {
  return withDatabaseOperation('/actions/threads/machine-state', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const { threadMachineAction } = await import('@/lib/cloud-computer/thread-machines')
    return threadMachineAction(pool, { userId: user.id, workspaceId: row.workspaceId ?? '' } as never, row.id, action)
  })
}

/** #2926 composer machine menu: the Keep awake switch, persisted on the
 * machine row for the lifecycle's idle-sleep decision. */
export async function setThreadMachineKeepAwake(issueId: string | null, runId: string, keepAwake: boolean) {
  return withDatabaseOperation('/actions/threads/machine-keep-awake', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    return (await import('@/lib/thread-workspace')).setThreadMachineKeepAwake(pool, user.id, row.workspaceId ?? null, row.id, keepAwake)
  })
}

/** #2926 composer machine menu: Move to cloud / a device — the move route's
 * own handler, as a server action for the composer. */
export async function moveThreadToTarget(issueId: string | null, runId: string, target: { deviceId: string | 'cloud' }) {
  return withDatabaseOperation('/actions/threads/move', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    return (await import('@/lib/thread-lifecycle')).moveThread(user, row.id, target)
  })
}

/** #2926 usage-limit card: try every quota-paused thread again with its own
 * credential — per-run failures are skipped, like the bulk credits switch. */
export async function retryAllQuotaPausedRuns(): Promise<{ runId: string; retried: boolean }[]> {
  const userId = await getUserId()
  const { pausedQuotaRuns, retryQuotaPausedRun } = await import('@/lib/run-quota')
  const results: { runId: string; retried: boolean }[] = []
  for (const runId of await pausedQuotaRuns(userId)) {
    try { await retryQuotaPausedRun(userId, runId); results.push({ runId, retried: true }) }
    catch { results.push({ runId, retried: false }) }
  }
  return results
}

/** #2940 item 5: the pull requests a thread's chain published, owner only —
 * the publication receipt is the requester's own record, like the run-location
 * icon getThreadMachine serves. */
export async function listThreadPulls(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/pulls', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    const pulls = await import('@/lib/thread-pulls')
    await pulls.drainThreadPullMergeIntents(pool, user.id, runIds)
    return pulls.listThreadPulls(pool, user.id, runIds)
  })
}

/** #2940 item 5: arm or clear "merge when ready" on a pull this thread
 * published. The intent never merges by itself — a read or poll drains it
 * through mergePullRequest's own gates, as the person with their token. */
export async function setThreadPullMergeWhenReady(issueId: string | null, runId: string, input: { repo: string; number: number; headSha: string; enabled: boolean; confirmFailedChecks?: boolean }) {
  return withDatabaseOperation('/actions/threads/pulls/merge-intent', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const { rows: [meta] } = await pool.query<{ issueId: string | null; workspaceId: string | null }>('SELECT "issueId","workspaceId" FROM agent_runs WHERE id=$1', [row.id])
    const pulls = await import('@/lib/thread-pulls')
    const state = await pulls.setThreadPullMergeIntent(pool, user.id, meta?.workspaceId ?? null, meta?.issueId ?? null, row.id, input)
    let outcome: { outcome: string; code: string | null } | null = null
    if (state === 'armed') {
      const chain = await readRunChain(pool, row.userId, row.id)
      const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
      // The first drain's verdict for this pull (merged/refused/still armed)
      // reaches the caller so the tab can say what actually happened. A
      // continuation can re-publish the same pull: the drain walks intents
      // oldest-first, so the freshest verdict is the last matching entry.
      outcome = (await pulls.drainThreadPullMergeIntents(pool, user.id, runIds))
        .findLast(entry => entry.repo === input.repo && entry.number === input.number) ?? null
    }
    return { state, outcome }
  })
}

/** #2940 item 5: one poll drains every armed merge intent on the thread's
 * chain — the "when ready" tick. Still-blocked pulls stay armed. */
export async function syncThreadPullMerges(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/pulls/merge-sync', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    return (await import('@/lib/thread-pulls')).drainThreadPullMergeIntents(pool, user.id, runIds)
  })
}

/** #2940 item 6: the review actor for this session — the same shape the git
 * HTTP routes build, so the thread adapter reaches the existing git service
 * unchanged rather than re-implementing it. */
async function threadReviewActor() {
  const { getApiSession } = await import('@/lib/api-auth')
  const session = await getApiSession({ headers: await headers(), query: { disableCookieCache: true } })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id, credential: session.tokenId
    ? { kind: 'pat' as const, id: session.tokenId }
    : { kind: 'session' as const, id: session.session.id } }
}

async function threadGitScope(issueId: string | null, runId: string) {
  const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
  if (row.userId !== user.id) return null
  const { rows: [meta] } = await pool.query<{ deviceRepoId: string | null }>('SELECT "deviceRepoId" FROM agent_runs WHERE id=$1', [row.id])
  if (!meta?.deviceRepoId) return null
  return { actor: await threadReviewActor(), runId: row.id, repoId: meta.deviceRepoId }
}

/** #2940 item 6: git status adapted to the thread — resolves the run's repo
 * itself and delegates to lib/coding-workspace/git unchanged. */
export async function getThreadGitStatus(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/git-status', async () => {
    const scope = await threadGitScope(issueId, runId)
    if (!scope) return null
    const { getRunGitStatus } = await import('@/lib/coding-workspace/git/service')
    const { workspacePool } = await import('@/lib/workspace-db')
    return (await getRunGitStatus({ database: pool, membership: workspacePool }, scope.actor, scope.runId, scope.repoId)).value
  })
}

/** #2940 item 6: git history adapted to the thread, paged like the route. */
export async function getThreadGitHistory(issueId: string | null, runId: string, input?: { cursor?: string; limit?: number }) {
  return withDatabaseOperation('/actions/threads/git-history', async () => {
    const scope = await threadGitScope(issueId, runId)
    if (!scope) return null
    const { listRunGitHistory } = await import('@/lib/coding-workspace/git/service')
    const { workspacePool } = await import('@/lib/workspace-db')
    return (await listRunGitHistory({ database: pool, membership: workspacePool }, scope.actor, scope.runId, scope.repoId,
      { ...(input?.cursor ? { cursor: input.cursor } : {}), limit: input?.limit ?? 20 })).value
  })
}

/** #2940 item 3/6: the run's checkpoint/snapshot list, adapted to the thread. */
export async function listThreadGitCheckpoints(issueId: string | null, runId: string) {
  return withDatabaseOperation('/actions/threads/git-checkpoints', async () => {
    const scope = await threadGitScope(issueId, runId)
    if (!scope) return null
    const { listRunCheckpoints } = await import('@/lib/coding-workspace/git/service')
    const { workspacePool } = await import('@/lib/workspace-db')
    return (await listRunCheckpoints({ database: pool, membership: workspacePool }, scope.actor, scope.runId, scope.repoId))
  })
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function stopRun(runId: string): Promise<{ stoppedRunIds: string[] }> {
  return withOwnWorkspaceRun(runId, userId => requestRunStop(userId, runId))
}

/** A run paused because its subscription's quota ran out goes on with the person's API key. Owner only; a repeat returns the same run. */
export async function resumeQuotaPausedRunOnApiKey(runId: string): Promise<{ runId: string }> {
  return withOwnWorkspaceRun(runId, async userId => (await import('@/lib/run-quota')).resumeQuotaPausedRunOnApiKey(userId, runId))
}

/** A run paused because its subscription's quota ran out is tried again with its original credential. Owner only; a repeat returns the same run. */
export async function retryQuotaPausedRun(runId: string): Promise<{ runId: string }> {
  return withOwnWorkspaceRun(runId, async userId => (await import('@/lib/run-quota')).retryQuotaPausedRun(userId, runId))
}

/** A quota-paused run switches to a Mikka 额度 model (a LiteLLM catalogue id). Owner only. */
export async function resumeQuotaPausedRunOnCredits(runId: string, model: string): Promise<{ runId: string }> {
  return withOwnWorkspaceRun(runId, async userId => (await import('@/lib/run-quota')).resumeQuotaPausedRunOnCredits(userId, runId, model))
}

/** #2938 (5): every quota-paused thread of the person moves to Mikka 额度 at once. */
export async function resumeAllQuotaPausedOnCredits(model: string): Promise<{ runId: string; continued: string | null }[]> {
  const userId = await getUserId()
  return (await import('@/lib/run-quota')).resumeAllQuotaPausedOnCredits(userId, model)
}

/** Settings #504 queues maintenance through the same owner-scoped backend as HTTP. */
export async function sendDeviceCommand(input: { deviceId: string; kind: DeviceCommandKind }): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ deviceId: z.uuid(), kind: z.enum(['redetect', 'restart', 'update']) }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNotFound' }
    const id = await enqueueDeviceCommand(userId, parsed.data.deviceId, parsed.data.kind)
    return id ? { id } : { error: 'deviceNotFound' }
  })
}
