import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { telegramLinks } from '@/lib/db/schema'
import { readEnv } from '@/lib/env/server'

export async function readTelegramIntegrationStatus(userId: string) {
  const username = readEnv('TELEGRAM_BOT_USERNAME')?.replace(/^@/, '')
  const [link] = await db.select({
    telegramUserName: telegramLinks.telegramUserName,
    linkedAt: telegramLinks.linkedAt,
  }).from(telegramLinks).where(eq(telegramLinks.userId, userId)).limit(1)
  return {
    configured: !!(readEnv('TELEGRAM_BOT_TOKEN') && readEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN') && username),
    botUsername: username ?? null,
    connected: !!link,
    telegramUserName: link?.telegramUserName ?? null,
    linkedAt: link?.linkedAt.toISOString() ?? null,
  }
}
