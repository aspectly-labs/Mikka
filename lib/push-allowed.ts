import type { Preferences } from '@/lib/preferences'
import type { PushReason } from '@/lib/push-reasons'
import { safeTimeZone } from '@/lib/suggestions/briefing'

export const DND_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type DndDay = (typeof DND_DAYS)[number]
export const DND_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
export const NOTIFICATION_SOUNDS = ['default', 'subtle', 'chime', 'none'] as const
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number]
export type NotificationChannel = 'mobile' | 'desktop'

export interface DndSchedule {
  enabled: boolean
  start: string
  end: string
  days: readonly DndDay[]
}

export const DEFAULT_DND_SCHEDULE: DndSchedule = {
  enabled: false,
  start: '22:00',
  end: '08:00',
  days: DND_DAYS,
}

export type ChannelCategoryOverrides = Partial<Record<PushReason, boolean | null | undefined>>

const FLAG = { decide: 'pushDecide', review: 'pushReview', finished: 'pushFinished', briefing: 'pushBriefing' } as const satisfies Record<PushReason, keyof Preferences>
const PREVIOUS_DAY: Record<DndDay, DndDay> = {
  mon: 'sun', tue: 'mon', wed: 'tue', thu: 'wed', fri: 'thu', sat: 'fri', sun: 'sat',
}

function clockMinutes(hhmm: string): number | null {
  if (!DND_TIME_PATTERN.test(hhmm)) return null
  const [hours, minutes] = hhmm.split(':').map(Number)
  return hours! * 60 + minutes!
}

function localWeekdayAndMinutes(timeZone: string | null | undefined, now: Date): { day: DndDay; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  const rawDay = part('weekday').toLowerCase()
  const day = (DND_DAYS as readonly string[]).includes(rawDay) ? (rawDay as DndDay) : 'mon'
  return { day, minutes: Number(part('hour')) * 60 + Number(part('minute')) }
}

/**
 * Evaluates whether `now` falls inside the person's scheduled Do Not Disturb
 * window in their IANA time zone (falling back to UTC when unknown).
 * Overnight windows (`start > end`, e.g. 22:00 -> 08:00) match `day` before
 * midnight and `PREVIOUS_DAY[day]` after midnight until `end`.
 */
export function inDndWindow(schedule: DndSchedule, timeZone?: string | null, now: Date = new Date()): boolean {
  if (!schedule.enabled || schedule.days.length === 0) return false
  const start = clockMinutes(schedule.start)
  const end = clockMinutes(schedule.end)
  if (start === null || end === null) return false
  const activeDays = new Set(schedule.days)
  const { day, minutes } = localWeekdayAndMinutes(timeZone, now)
  if (start === end) return activeDays.has(day)
  if (start < end) return activeDays.has(day) && minutes >= start && minutes < end
  if (minutes >= start) return activeDays.has(day)
  if (minutes < end) return activeDays.has(PREVIOUS_DAY[day])
  return false
}

export interface PushPolicyOptions {
  overrides?: ChannelCategoryOverrides
  dnd?: DndSchedule
  timeZone?: string | null
  now?: Date
}

/**
 * Whether the person's 通知 settings let a notification with these reasons reach
 * the target channel. Explicit per-channel `personal_setting_values` overrides
 * win; null/undefined falls back to `user_preferences.push*`.
 */
export function pushAllowed(
  preferences: Pick<Preferences, 'proactive' | (typeof FLAG)[PushReason]>,
  reasons: readonly PushReason[],
  options?: PushPolicyOptions,
): boolean {
  if (!preferences.proactive || !reasons.length) return false
  if (options?.dnd && inDndWindow(options.dnd, options.timeZone, options.now)) return false
  return reasons.some(reason => {
    const override = options?.overrides?.[reason]
    const allowed = typeof override === 'boolean' ? override : preferences[FLAG[reason]]
    return allowed === true
  })
}
