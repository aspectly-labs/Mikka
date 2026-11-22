'use client'

import useSWR from 'swr'
import { getBotModelMenu } from '@/app/actions/execution-settings'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'

/** The SWR key of a chat's model menu. */
export const botModelMenuKey = (botId: string | null) => ['bot-model-menu', botId ?? 'coordinator'] as const

/** The last model menu read in any chat */
let lastMenu: BotModelMenu | undefined

/**
 * A chat's model menu. Until this Bot's menu is read, the last one read in any chat stands in for it: readiness is
 * mostly the workspace's credits and connections, and a Bot switch (the new chat and its footer mount anew) then
 * draws its footer with the chat instead of growing it a moment later under a chat drawn at its end.
 */
export function useBotModelMenu(botId: string | null) {
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId), { keepPreviousData: true, fallbackData: lastMenu })
  if (menu.data) lastMenu = menu.data
  return menu
}
