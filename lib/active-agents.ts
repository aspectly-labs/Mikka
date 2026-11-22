import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { agentRuns, agents, conversationMembers, coordinatorBots, coordinatorSessions, devices, bots, conversations, groupTurns } from '@/lib/db/schema'
import type * as schema from '@/lib/db/schema'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import { deviceSessionOpen } from './device-presence'
import { WORKING_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { runBotName } from '@/lib/run-bot-name'

// MIK-7: the agents working for the signed-in person right now, for the
// "who is working" strip. Only the caller's own runs and agents; no prompt,
// worktree, device or error fields leave the server.


export type ActiveAgent = {
  id: string
  kind: 'agent' | 'coordinator' | 'bot'
  name: string
  avatarUrl: null
  startedAt: string
  state: 'working' | 'waiting_input'
  runId: string | null
  issueId: string | null
  color?: string
  shape?: string
}

export const COORDINATOR_NAME = 'Coordinator'

type Database = NodePgDatabase<typeof schema>
type ActiveRunRow = { agentId: string; name: string; runId: string; issueId: string | null; status: string; startedAt: Date }

/**
 * One entry per agent. An agent with several live runs shows its earliest
 * start; it is `working` if any run is working, `waiting_input` only when every
 * run is waiting. runId/issueId come from the earliest run.
 */
export function mergeAgentRuns(rows: ActiveRunRow[]): ActiveAgent[] {
  const byAgent = new Map<string, { first: ActiveRunRow; working: boolean }>()
  for (const row of rows) {
    const working = row.status !== 'waiting_input'
    const seen = byAgent.get(row.agentId)
    if (!seen) { byAgent.set(row.agentId, { first: row, working }); continue }
    seen.working ||= working
    if (row.startedAt < seen.first.startedAt || (+row.startedAt === +seen.first.startedAt && row.runId < seen.first.runId)) seen.first = row
  }
  return [...byAgent.entries()].map(([id, { first, working }]) => ({
    id, kind: 'agent' as const, name: first.name, avatarUrl: null, startedAt: first.startedAt.toISOString(),
    state: working ? 'working' as const : 'waiting_input' as const, runId: first.runId, issueId: first.issueId,
  }))
}

/** Earliest start first; ties by id so polling does not reshuffle the list. */
export function sortActiveAgents(list: ActiveAgent[]): ActiveAgent[] {
  return [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The group's non-user member ids, split by kind; left members do not count. */
async function conversationMemberIds(database: Database, conversationId: string): Promise<{ agents: string[]; bots: string[] }> {
  const rows = await database.select({ memberType: conversationMembers.memberType, memberId: conversationMembers.memberId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)))
  return {
    agents: rows.filter(row => row.memberType === 'agent').map(row => row.memberId),
    bots: rows.filter(row => row.memberType === 'bot').map(row => row.memberId),
  }
}

/** A signed-in person may scope the strip to a group they are a user member of. */
export async function isConversationUserMember(database: Database, conversationId: string, userId: string, workspaceId?: string | null): Promise<boolean> {
  if (workspaceId) {
    const scopeRows = await database.select({ workspaceId: conversations.workspaceId }).from(conversations)
      .where(eq(conversations.id, conversationId)).limit(1)
    if (scopeRows[0]?.workspaceId !== workspaceId) return false // a workspace-scoped token cannot reach another workspace's group
  }
  const rows = await database.select({ memberId: conversationMembers.memberId }).from(conversationMembers)
    .where(and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.memberType, 'user'),
      eq(conversationMembers.memberId, userId),
      isNull(conversationMembers.leftAt),
    )).limit(1)
  return rows.length > 0
}

export async function listActiveAgents(database: Database, userId: string, now = new Date(), workspaceId?: string, conversationId?: string): Promise<ActiveAgent[]> {
  // A group-scoped read returns only that group's members (#101): accounts show
  // every agent they own, a group shows only the agents and bots enrolled in it.
  const members = conversationId ? await conversationMemberIds(database, conversationId) : null
  const agentIds = members?.agents ?? []
  const botIds = members?.bots ?? []
  if (members && !agentIds.length && !botIds.length) return []
  const startedAt = sql<Date>`coalesce(${agentRuns.startedAt}, ${agentRuns.createdAt})`.mapWith(agentRuns.createdAt)
  const [rows, [session], workingBots] = await Promise.all([
    members && !agentIds.length ? [] :
    database.select({ agentId: agents.id, name: runBotName, runId: agentRuns.id, issueId: agentRuns.issueId, status: agentRuns.status, startedAt })
      .from(agentRuns)
      .innerJoin(agents, and(eq(agents.id, agentRuns.agentId), eq(agents.userId, userId), members ? inArray(agents.id, agentIds) : undefined))
      .leftJoin(devices, and(eq(devices.id, agentRuns.deviceId), eq(devices.ownerId, userId)))
      .where(and(
        eq(agentRuns.userId, userId),
        // Token-bound readers must not project runs from another workspace.
        workspaceId ? eq(agentRuns.workspaceId, workspaceId) : undefined,
        inArray(agentRuns.status, [...WORKING_RUN_STATUSES]),
        or(gt(agentRuns.leaseExpiresAt, now), and(isNull(agentRuns.leaseExpiresAt), deviceSessionOpen)),
      )),
    // The Coordinator's chat is its bot row's (coordinator_bots).
    database.select({ botId: coordinatorBots.botId, leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil, updatedAt: coordinatorSessions.updatedAt })
      .from(coordinatorSessions).innerJoin(coordinatorBots, and(eq(coordinatorBots.botId, coordinatorSessions.botId), eq(coordinatorBots.ownerId, userId), workspaceId ? eq(coordinatorBots.workspaceId, workspaceId) : undefined, members ? inArray(coordinatorBots.botId, botIds) : undefined))
      .where(eq(coordinatorSessions.userId, userId)).orderBy(desc(coordinatorSessions.updatedAt)).limit(1),
    members && !botIds.length ? [] :
    database.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, startedAt: groupTurns.updatedAt })
      .from(groupTurns)
      .innerJoin(conversations, and(eq(conversations.id, groupTurns.conversationId), eq(conversations.createdBy, userId)))
      .innerJoin(bots, and(eq(bots.id, groupTurns.botId), eq(bots.ownerId, userId), eq(bots.workspaceId, conversations.workspaceId), members ? inArray(bots.id, botIds) : undefined))
      .where(and(eq(groupTurns.status, 'running'), gt(groupTurns.updatedAt, new Date(now.getTime() - 60_000)), workspaceId ? eq(bots.workspaceId, workspaceId) : undefined)),
  ])
  const list = mergeAgentRuns(rows)
  const byBot = new Map<string, typeof workingBots[number]>()
  for (const row of workingBots) if (!byBot.has(row.id) || row.startedAt < byBot.get(row.id)!.startedAt) byBot.set(row.id, row)
  for (const row of byBot.values()) list.push({ ...row, kind: 'bot', avatarUrl: null, startedAt: row.startedAt.toISOString(), state: 'working', runId: null, issueId: null })
  if (coordinatorLeaseActive(session, now)) {
    // coordinator_sessions has no turn start column yet, so startedAt uses updatedAt for now
    // (bumped when a turn takes or renews the lease). Replace once a real start time is stored.
    list.push({ id: session!.botId, kind: 'coordinator', name: COORDINATOR_NAME, avatarUrl: null, startedAt: session!.updatedAt.toISOString(), state: 'working', runId: null, issueId: null })
  }
  return sortActiveAgents(list)
}

type Copy = { pleaseSignIn: string; unavailable: string; noParameters: string; groupNotFound: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ActiveAgentsScope = {
  /** Whether the signed-in person is a user member of the conversation. */
  member: (userId: string, conversationId: string) => Promise<boolean>
  /** The group-filtered read: only that conversation's agent/bot members. */
  list: (userId: string, conversationId: string) => Promise<ActiveAgent[]>
}

/**
 * GET /api/agent/sessions/active, without the framework: the route passes the
 * signed-in user (or null) and the reader, so this is testable without a DB.
 * `?conversation=<id>` scopes the result to that group's members when `scope`
 * is given; a caller who is not a user member gets the same 404 as a group
 * that does not exist.
 */
export async function activeAgentsResponse(request: Request, userId: string | null, list: (userId: string) => Promise<ActiveAgent[]>, copy: Copy, scope?: ActiveAgentsScope): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (!userId) return Response.json({ error: copy.pleaseSignIn }, { status: 401, headers })
  const params = [...new URL(request.url).searchParams.entries()]
  const conversation = params.length === 1 && params[0][0] === 'conversation' && scope ? params[0][1] : null
  if (params.length && !conversation) return Response.json({ error: copy.noParameters }, { status: 400, headers })
  try {
    if (conversation) {
      if (!UUID.test(conversation) || !await scope!.member(userId, conversation))
        return Response.json({ error: copy.groupNotFound }, { status: 404, headers })
      const agents = await scope!.list(userId, conversation)
      return Response.json(agents.length ? { agents, polledAt: new Date().toISOString() } : { agents: [] }, { headers })
    }
    const agents = await list(userId)
    return Response.json(agents.length ? { agents, polledAt: new Date().toISOString() } : { agents: [] }, { headers })
  } catch {
    return Response.json({ error: copy.unavailable }, { status: 503, headers })
  }
}
