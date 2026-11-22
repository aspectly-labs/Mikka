/**
 * When a chat message was sent, in words (「今天 14:32」): the time in a message's action bar, shown on hover as
 * LobeHub's (components/chat/reply-actions.tsx). The chat draws no centred time over its messages (decision 2026-11-22-2000).
 */

export type StampWords = { today: (time: string) => string; yesterday: (time: string) => string }

const startOfDay = (at: number) => { const day = new Date(at); day.setHours(0, 0, 0, 0); return day.getTime() }

/** 「今天 14:32」, 「昨天 9:05」, the weekday within six days (as Capy's), then the date; the year only when it is not this year. */
export function chatStampText(at: number, now: number, locale: string, words: StampWords): string {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days === 0) return words.today(time)
  if (days === 1) return words.yesterday(time)
  // The weekday and the clock apart: zh-CN's combined pattern runs them together (「周五12:50」).
  if (days > 1 && days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at)} ${time}`
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at)
}
