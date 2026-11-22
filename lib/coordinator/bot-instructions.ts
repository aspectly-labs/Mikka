import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { instructionsWithBot } from './prompt-parts'

export { instructionsWithBot }

/**
 * The prompt for one chat. The Coordinator is the person's built-in bot; any
 * other bot does the same job with the same tools, under its own name.
 */
export async function botInstructions(userId: string, botId: string, base: string): Promise<string> {
  const [bot] = await db.select({ name: bots.name, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` })
    .from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1)
  return formatBotInstructions(base, bot)
}

/** Pure per-call formatting; metadata must come from the current owned bot read. */
export function formatBotInstructions(base: string, bot: { name: string; coordinator: boolean } | undefined): string {
  if (!bot || bot.coordinator) return base
  return `${base.replace('You are the Coordinator in Mikka', `You are ${bot.name}, one of the person's bots in Mikka`)}\n\nYour name is ${bot.name}. The person named you; answer to it and never call yourself the Coordinator. The Coordinator is another of their bots with its own chat.`
}

/** Reads the owned Bot's private `bots.instructions` under active workspace membership. */
export async function readBotCustomInstructions(userId: string, botId: string): Promise<string> {
  const [bot] = await db.select({
    workspaceId: bots.workspaceId,
    instructions: bots.instructions,
    archivedAt: bots.archivedAt,
  }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1)
  if (!bot) throw new ActionFailureError('botNotFound')
  return withTaskWorkspace(userId, bot.workspaceId, async () => bot.archivedAt ? '' : bot.instructions ?? '')
}

/** Appends `<bot_instructions>` for the owned Bot under active workspace membership. */
export async function withBotCustomInstructions(userId: string, botId: string, instructions: string): Promise<string> {
  return instructionsWithBot(instructions, await readBotCustomInstructions(userId, botId))
}
