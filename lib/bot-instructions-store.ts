import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { ActionFailureError } from '@/lib/action-error'
import { BOT_INSTRUCTIONS_MAX, botInstructionsSchema } from '@/lib/bot-settings'
import { botListChanged } from '@/lib/live/lists'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'

type Reader = Parameters<typeof withTaskWorkspace>[0]

export const saveBotInstructionsInput = z.object({
  botId: z.uuid(),
  workspaceId: z.uuid().optional(),
  instructions: botInstructionsSchema,
}).strict()

export interface BotInstructionsView {
  botId: string
  workspaceId: string
  name: string
  instructions: string
  charCount: number
  maxChars: number
  archived: boolean
  canEdit: boolean
  source: 'bot' | 'default'
}

type BotInstructionRow = {
  id: string
  workspaceId: string
  ownerId: string | null
  name: string
  instructions: string
  archivedAt: Date | null
  isCoordinator: boolean
  visibility: string
  inCallerGroup: boolean
}

async function queryBotInstructionRow(botId: string, callerId: string): Promise<BotInstructionRow | null> {
  const { rows: [row] } = await db.execute<BotInstructionRow>(sql`
    SELECT b.id,
      b."workspaceId",
      b."ownerId",
      b.name,
      b.instructions,
      b."archivedAt",
      EXISTS (SELECT 1 FROM coordinator_bots cb WHERE cb."botId" = b.id) AS "isCoordinator",
      COALESCE((
        SELECT p.visibility FROM resource_access_policies p
        WHERE p.kind = 'bot' AND p.id = b.id AND p."workspaceId" = b."workspaceId"
      ), 'private') AS visibility,
      EXISTS (
        SELECT 1 FROM conversation_members bm
        JOIN conversation_members um ON um."conversationId" = bm."conversationId"
        WHERE bm."memberType" = 'bot' AND bm."memberId" = b.id::text AND bm."leftAt" IS NULL
          AND um."memberType" = 'user' AND um."memberId" = ${callerId} AND um."leftAt" IS NULL
      ) AS "inCallerGroup"
    FROM bots b
    WHERE b.id = ${botId}::uuid
  `)
  return row ?? null
}

async function authorizeBotInstructionScope(
  tx: WorkspaceTransaction,
  callerId: string,
  bot: BotInstructionRow,
): Promise<{ role: 'admin' | 'member'; canEdit: boolean }> {
  const [member] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, bot.workspaceId), eq(workspaceMembers.userId, callerId), eq(workspaceMembers.status, 'active')))
  if (!member) throw new ActionFailureError('workspaceAccessDenied')
  const isOwner = bot.ownerId !== null && bot.ownerId === callerId
  const isAuthorizedAdmin = member.role === 'admin' && !bot.isCoordinator && (bot.ownerId === null || bot.visibility === 'shared')
  if (!isOwner && !isAuthorizedAdmin) {
    // Discoverable shared or group-chat Bots deny with 403; undisclosed private Bots return not found.
    if (bot.visibility === 'shared' || bot.inCallerGroup) throw new ActionFailureError('workspaceAccessDenied')
    throw new ActionFailureError('botNotFound')
  }
  return { role: member.role, canEdit: !bot.archivedAt }
}

/**
 * Reads private `bots.instructions` for the Bot's owner or an authorized workspace
 * administrator (shared or orphaned non-Coordinator Bot). Ordinary workspace members,
 * followers, and group chat participants never receive private Bot instructions.
 */
export async function readBotInstructions(reader: Reader, botId: string, requestedWorkspaceId?: string): Promise<BotInstructionsView> {
  if (!z.uuid().safeParse(botId).success) throw new ActionFailureError('botNotFound')
  if (requestedWorkspaceId !== undefined && !z.uuid().safeParse(requestedWorkspaceId).success) {
    throw new ActionFailureError('validationGeneric')
  }
  const { userId } = taskReaderScope(reader)
  if (requestedWorkspaceId) {
    return withTaskWorkspace(reader, requestedWorkspaceId, async (_workspace, tx) => {
      const bot = await queryBotInstructionRow(botId, userId)
      if (!bot || bot.workspaceId !== requestedWorkspaceId) throw new ActionFailureError('botNotFound')
      const { canEdit } = await authorizeBotInstructionScope(tx, userId, bot)
      const instructions = bot.instructions ?? ''
      return {
        botId: bot.id,
        workspaceId: bot.workspaceId,
        name: bot.name,
        instructions,
        charCount: [...instructions].length,
        maxChars: BOT_INSTRUCTIONS_MAX,
        archived: Boolean(bot.archivedAt),
        canEdit,
        source: instructions ? 'bot' : 'default',
      }
    })
  }
  const bot = await queryBotInstructionRow(botId, userId)
  if (!bot) throw new ActionFailureError('botNotFound')
  let enteredWorkspace = false
  try {
    return await withTaskWorkspace(reader, bot.workspaceId, async (_workspace, tx) => {
      enteredWorkspace = true
      const { canEdit } = await authorizeBotInstructionScope(tx, userId, bot)
      const instructions = bot.instructions ?? ''
      return {
        botId: bot.id,
        workspaceId: bot.workspaceId,
        name: bot.name,
        instructions,
        charCount: [...instructions].length,
        maxChars: BOT_INSTRUCTIONS_MAX,
        archived: Boolean(bot.archivedAt),
        canEdit,
        source: instructions ? 'bot' : 'default',
      }
    })
  } catch (error) {
    // Without an explicit workspaceId, cross-workspace probes receive 404 rather than confirming the Bot exists.
    if (!enteredWorkspace && (error instanceof ActionFailureError || error instanceof WorkspaceError) && error.code === 'workspaceAccessDenied') {
      throw new ActionFailureError('botNotFound', undefined, undefined, { cause: error })
    }
    throw error
  }
}

/**
 * Updates private `bots.instructions` for the Bot's owner or an authorized workspace
 * administrator (shared or orphaned non-Coordinator Bot). Archived Bots reject mutations.
 */
export async function saveBotInstructions(reader: Reader, raw: unknown): Promise<BotInstructionsView> {
  const parsed = saveBotInstructionsInput.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    if (first?.path[0] === 'botId') throw new ActionFailureError('botNotFound')
    const tooLong = parsed.error.issues.some(issue => issue.path[0] === 'instructions' && issue.message === 'personalInstructionsTooLong')
    throw new ActionFailureError(tooLong ? 'personalInstructionsTooLong' : 'validationGeneric')
  }
  const { botId, workspaceId: requestedWorkspaceId, instructions } = parsed.data
  const { userId } = taskReaderScope(reader)
  const mutateInWorkspace = async (workspaceId: string, tx: WorkspaceTransaction): Promise<BotInstructionsView> => {
    const bot = await queryBotInstructionRow(botId, userId)
    if (!bot || bot.workspaceId !== workspaceId) throw new ActionFailureError('botNotFound')
    await authorizeBotInstructionScope(tx, userId, bot)
    if (bot.archivedAt) throw new ActionFailureError('projectArchived')
    const { rows: [updated] } = await db.execute<{ id: string; name: string; instructions: string }>(sql`
      UPDATE bots
      SET instructions = ${instructions}, "updatedAt" = now()
      WHERE id = ${bot.id}::uuid AND "workspaceId" = ${workspaceId}::uuid AND "archivedAt" IS NULL
      RETURNING id, name, instructions
    `)
    if (!updated) throw new ActionFailureError('projectArchived')
    await botListChanged(db, bot.id)
    return {
      botId: updated.id,
      workspaceId,
      name: updated.name,
      instructions: updated.instructions,
      charCount: [...updated.instructions].length,
      maxChars: BOT_INSTRUCTIONS_MAX,
      archived: false,
      canEdit: true,
      source: updated.instructions ? 'bot' : 'default',
    }
  }

  if (requestedWorkspaceId) {
    return withTaskWorkspace(reader, requestedWorkspaceId, (_workspace, tx) => mutateInWorkspace(requestedWorkspaceId, tx))
  }
  const bot = await queryBotInstructionRow(botId, userId)
  if (!bot) throw new ActionFailureError('botNotFound')
  let enteredWorkspace = false
  try {
    return await withTaskWorkspace(reader, bot.workspaceId, (_workspace, tx) => {
      enteredWorkspace = true
      return mutateInWorkspace(bot.workspaceId, tx)
    })
  } catch (error) {
    if (!enteredWorkspace && (error instanceof ActionFailureError || error instanceof WorkspaceError) && error.code === 'workspaceAccessDenied') {
      throw new ActionFailureError('botNotFound', undefined, undefined, { cause: error })
    }
    throw error
  }
}
