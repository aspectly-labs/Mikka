import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { instructionsWithEnvironment } from './prompt-parts'

export { instructionsWithEnvironment }

export interface ScopedBotPromptInstructions {
  environmentId: string | null
  environmentInstructions: string
  botInstructions: string
}

/**
 * Reads the Bot's live Environment instructions and private Bot instructions in one
 * owned-Bot check and one active workspace membership lease (`withTaskWorkspace`).
 * Archived environments and archived Bots contribute no standing instructions.
 */
export async function readScopedPromptInstructionsForBot(userId: string, botId: string): Promise<ScopedBotPromptInstructions> {
  const [bot] = await db.select({
    workspaceId: bots.workspaceId,
    environmentId: bots.environmentId,
    instructions: bots.instructions,
    archivedAt: bots.archivedAt,
  }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  return withTaskWorkspace(userId, bot.workspaceId, async (_workspace, tx) => {
    let environmentInstructions = ''
    let activeEnvironmentId: string | null = null
    if (bot.environmentId) {
      const { rows: [env] } = await tx.execute<{ id: string; instructions: string }>(
        sql`select id, instructions from workspace_environments
          where id=${bot.environmentId} and "workspaceId"=${bot.workspaceId} and "archivedAt" is null and scope='workspace'`,
      )
      if (env) {
        activeEnvironmentId = env.id
        environmentInstructions = env.instructions ?? ''
      }
    }
    return {
      environmentId: activeEnvironmentId,
      environmentInstructions,
      botInstructions: bot.archivedAt ? '' : bot.instructions ?? '',
    }
  })
}

/** Reads only the live Environment's standing instructions for an owned Bot under active workspace membership. */
export async function readEnvironmentInstructionsForBot(userId: string, botId: string): Promise<string> {
  return (await readScopedPromptInstructionsForBot(userId, botId)).environmentInstructions
}

/** Appends `<environment_instructions>` for an owned Bot's live Environment under active workspace membership. */
export async function withEnvironmentInstructions(userId: string, botId: string, instructions: string): Promise<string> {
  return instructionsWithEnvironment(instructions, await readEnvironmentInstructionsForBot(userId, botId))
}
