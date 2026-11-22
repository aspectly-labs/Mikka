import { failure, turns, type SessionView } from 'eve/events'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'

/**
 * The chat's footer (UX audit 2026-11-22, issue 1): one blocking notice above the composer, chosen by priority. A row's
 * identity is the conversation layer's (lib/conversation/ids.ts).
 */

/**
 * The blocking notices above the composer, highest first; only the first that applies shows. A turn's failure is not
 * one of them: it is the reply's own error line (lib/conversation/project.ts), the chat's one error surface.
 */
export const BLOCKING_NOTICES = ['load', 'quotaStopped', 'model', 'quota', 'unanswered'] as const
export type BlockingNotice = typeof BLOCKING_NOTICES[number]

export function blockingNotice(applies: Partial<Record<BlockingNotice, boolean>>): BlockingNotice | null {
  return BLOCKING_NOTICES.find(kind => applies[kind]) ?? null
}

/**
 * The stream failed to load (to connect, catch up or resume), as opposed to a turn that ran and failed: that one is
 * the chat's own failure line, read from the stored chat. Eve reports both in `error`; a recorded failure of the
 * latest turn or of the session is the turn's, and a send the chat already marked failed shows on its own bubble.
 */
export function streamLoadFailed(error: Error | undefined, view: SessionView | undefined, sendFailed = false) {
  if (!error || sendFailed) return false
  if (!view) return true
  return failure(view, turns(view).at(-1)?.turnId) === undefined
}

/** Nothing can answer: no model chosen and none to choose, or the chosen Mikka 额度 is unavailable. Send waits. */
export function modelBlocked(menu: BotModelMenu | undefined) {
  const current = menu?.current
  return current?.kind === 'none' || (current?.kind === 'hosted' && !current.available)
}
