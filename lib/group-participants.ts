import type { PoolClient } from 'pg'

export interface GroupParticipant {
  id: string; name: string; harness: string; avatarUrl: null
  memberType?: 'bot'; color?: string; shape?: string
  publicRole?: string
  /** The owner's Coordinator (coordinator_bots): it wears the Coordinator's look, as the bot list draws it. */
  coordinator?: true
}

/** Source-owner identities only. Bot lookup additionally requires the exact
 * source workspace, never a guessed alias to an internal execution agent.
 */
export async function groupParticipants(client: PoolClient, conversationId: string, ownerId: string, workspaceId: string): Promise<GroupParticipant[]> {
  const members = (await client.query<{ memberType: string; memberId: string }>(`SELECT "memberType","memberId" FROM conversation_members
    WHERE "conversationId"=$1 AND "memberType" IN ('agent','bot') AND "leftAt" IS NULL ORDER BY "memberId"`, [conversationId])).rows
  const agents = members.filter(m => m.memberType === 'agent').map(m => m.memberId)
  const bots = members.filter(m => m.memberType === 'bot').map(m => m.memberId)
  const found: GroupParticipant[] = []
  if (agents.length) found.push(...(await client.query<GroupParticipant>(`SELECT id,name,harness,NULL AS "avatarUrl" FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])`, [ownerId, agents])).rows)
  if (bots.length) found.push(...(await client.query<GroupParticipant & { isCoordinator: boolean }>(`SELECT id,name,'ai_sdk' AS harness,NULL AS "avatarUrl",'bot' AS "memberType",color,shape,"publicRole",
    EXISTS (SELECT 1 FROM coordinator_bots cb WHERE cb."botId"=bots.id AND cb."ownerId"=bots."ownerId") AS "isCoordinator"
    FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND id=ANY($3::uuid[])`, [ownerId, workspaceId, bots])).rows.map(({ isCoordinator, ...row }) => isCoordinator ? { ...row, coordinator: true as const } : row))
  return members.flatMap(member => { const row = found.find(p => p.id === member.memberId && (p.memberType ?? 'agent') === member.memberType); return row ? [row] : [] })
}

/** groupParticipants for many conversations in three queries total (delta reads emit
 * every exchange up to the tip; one query per link would read linearly in history size). */
export async function groupParticipantsMany(client: PoolClient, conversationIds: string[], ownerId: string, workspaceId: string): Promise<Map<string, GroupParticipant[]>> {
  if (!conversationIds.length) return new Map()
  const members = (await client.query<{ conversationId: string; memberType: string; memberId: string }>(`SELECT "conversationId","memberType","memberId" FROM conversation_members
    WHERE "conversationId"=ANY($1::uuid[]) AND "memberType" IN ('agent','bot') AND "leftAt" IS NULL ORDER BY "memberId"`, [conversationIds])).rows
  const agents = [...new Set(members.filter(m => m.memberType === 'agent').map(m => m.memberId))]
  const bots = [...new Set(members.filter(m => m.memberType === 'bot').map(m => m.memberId))]
  const found: GroupParticipant[] = []
  if (agents.length) found.push(...(await client.query<GroupParticipant>(`SELECT id,name,harness,NULL AS "avatarUrl" FROM agents WHERE "userId"=$1 AND id=ANY($2::uuid[])`, [ownerId, agents])).rows)
  if (bots.length) found.push(...(await client.query<GroupParticipant & { isCoordinator: boolean }>(`SELECT id,name,'ai_sdk' AS harness,NULL AS "avatarUrl",'bot' AS "memberType",color,shape,"publicRole",
    EXISTS (SELECT 1 FROM coordinator_bots cb WHERE cb."botId"=bots.id AND cb."ownerId"=bots."ownerId") AS "isCoordinator"
    FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND id=ANY($3::uuid[])`, [ownerId, workspaceId, bots])).rows.map(({ isCoordinator, ...row }) => isCoordinator ? { ...row, coordinator: true as const } : row))
  const byConversation = new Map<string, GroupParticipant[]>()
  for (const member of members) {
    const row = found.find(p => p.id === member.memberId && (p.memberType ?? 'agent') === member.memberType)
    if (!row) continue
    const list = byConversation.get(member.conversationId) ?? []
    list.push(row)
    byConversation.set(member.conversationId, list)
  }
  return byConversation
}

/** A Bot member's face for a group's avatar in the chat list: no name, only what the bloub needs. */
export type GroupBotFace = { id: string; color: string | null; shape: string | null; coordinator?: true }

/**
 * The Bot members of many groups, each group's in member order (as GET members lists them), at most `limit` each, for
 * the chat list's group avatar (R-36): the sidebar row draws the same avatar as the group page without a member read
 * per row. Each group's Bots are its owner's in its workspace, as groupParticipants reads them.
 */
export async function groupBotFaces(client: PoolClient, groups: readonly { id: string; createdBy: string; workspaceId: string }[], limit = 3): Promise<Map<string, GroupBotFace[]>> {
  const faces = new Map<string, GroupBotFace[]>()
  if (!groups.length) return faces
  const members = (await client.query<{ conversationId: string; memberId: string }>(`SELECT "conversationId","memberId" FROM conversation_members
    WHERE "conversationId"=ANY($1::uuid[]) AND "memberType"='bot' AND "leftAt" IS NULL ORDER BY "memberId"`, [groups.map(group => group.id)])).rows
  if (!members.length) return faces
  const owners = new Map<string, { ownerId: string; workspaceId: string; bots: Set<string> }>()
  for (const member of members) {
    const group = groups.find(item => item.id === member.conversationId)
    if (!group) continue
    const key = `${group.createdBy}\u0000${group.workspaceId}`
    const entry = owners.get(key) ?? { ownerId: group.createdBy, workspaceId: group.workspaceId, bots: new Set<string>() }
    entry.bots.add(member.memberId)
    owners.set(key, entry)
  }
  const found = new Map<string, GroupBotFace>()
  for (const { ownerId, workspaceId, bots } of owners.values()) {
    const rows = (await client.query<{ id: string; color: string | null; shape: string | null; isCoordinator: boolean }>(`SELECT id,color,shape,
      EXISTS (SELECT 1 FROM coordinator_bots cb WHERE cb."botId"=bots.id AND cb."ownerId"=bots."ownerId") AS "isCoordinator"
      FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND id=ANY($3::uuid[])`, [ownerId, workspaceId, [...bots]])).rows
    for (const { isCoordinator, ...row } of rows) found.set(`${ownerId}\u0000${workspaceId}\u0000${row.id}`, { ...row, ...(isCoordinator ? { coordinator: true as const } : {}) })
  }
  for (const member of members) {
    const group = groups.find(item => item.id === member.conversationId)
    const bot = group && found.get(`${group.createdBy}\u0000${group.workspaceId}\u0000${member.memberId}`)
    if (!group || !bot) continue
    const list = faces.get(group.id) ?? []
    if (list.length >= limit) continue
    list.push(bot)
    faces.set(group.id, list)
  }
  return faces
}
