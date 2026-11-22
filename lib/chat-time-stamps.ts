/**
 * The centred timestamp above a run of chat messages (#2922, Figma 1318:3 「今天 14:32」): it opens the first message
 * and each group that starts after a quiet gap, never the messages written close together.
 */

/** Messages closer than this read as one group under one timestamp. */
export const STAMP_GAP_MS = 15 * 60_000

const readable = (at: number) => Number.isFinite(at) && at > 0

/** For each message time, in order, whether a timestamp goes above it. A message with no readable time never starts a group. */
export function stampStarts(times: readonly number[]): boolean[] {
  let previous: number | null = null
  return times.map(at => {
    if (!readable(at)) return false
    const starts = previous === null || at - previous >= STAMP_GAP_MS
    previous = at
    return starts
  })
}

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
