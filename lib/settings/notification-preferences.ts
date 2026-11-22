import 'server-only'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'
import {
  DEFAULT_DND_SCHEDULE,
  type ChannelCategoryOverrides,
  type DndDay,
  type DndSchedule,
  type NotificationSound,
} from '@/lib/push-allowed'
import { readTimeZoneSetting } from '@/lib/suggestions/time-zone'
import { SETTINGS_REGISTRY } from './registry'
import { personalSettingValues } from './schema'

const NOTIFICATION_SETTING_KEYS = [
  'dndEnabled',
  'dndStart',
  'dndEnd',
  'dndDays',
  'notifyMobileDecide',
  'notifyMobileReview',
  'notifyMobileFinished',
  'notifyMobileBriefing',
  'notifyDesktopDecide',
  'notifyDesktopReview',
  'notifyDesktopFinished',
  'notifyDesktopBriefing',
  'notifyEmailInvitations',
  'notificationSound',
] as const

export interface NotificationRuntimeSettings {
  dnd: DndSchedule
  timeZone: string | null
  mobile: ChannelCategoryOverrides
  desktop: ChannelCategoryOverrides
  emailInvitations: boolean | null
  sound: NotificationSound
}

function safeParseString<T extends string>(guard: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  const parsed = guard.safeParse(raw)
  return parsed.success ? (parsed.data as T) : fallback
}

function safeParseDays(raw: string[] | null | undefined): readonly DndDay[] {
  if (raw == null) return DEFAULT_DND_SCHEDULE.days
  const parsed = SETTINGS_REGISTRY.dndDays.guard.safeParse(raw)
  return parsed.success ? (parsed.data as DndDay[]) : DEFAULT_DND_SCHEDULE.days
}

/**
 * Reads account-scoped notification preferences from `personal_setting_values`
 * alongside the person's effective IANA time zone (`readTimeZoneSetting`).
 * Unset (`null`) channel overrides leave legacy `user_preferences` fallback intact.
 */
export async function readNotificationRuntimeSettings(userId: string): Promise<NotificationRuntimeSettings> {
  const [rows, tz] = await Promise.all([
    db.select({
      key: personalSettingValues.key,
      booleanValue: personalSettingValues.booleanValue,
      textValue: personalSettingValues.textValue,
      textArrayValue: personalSettingValues.textArrayValue,
    }).from(personalSettingValues).where(and(
      eq(personalSettingValues.userId, userId),
      isNull(personalSettingValues.workspaceId),
      inArray(personalSettingValues.key, [...NOTIFICATION_SETTING_KEYS]),
    )),
    readTimeZoneSetting(userId),
  ])
  const byKey = new Map(rows.map(row => [row.key, row]))
  const bool = (key: string): boolean | null => byKey.get(key)?.booleanValue ?? null
  return {
    dnd: {
      enabled: bool('dndEnabled') ?? DEFAULT_DND_SCHEDULE.enabled,
      start: safeParseString(SETTINGS_REGISTRY.dndStart.guard, byKey.get('dndStart')?.textValue, DEFAULT_DND_SCHEDULE.start),
      end: safeParseString(SETTINGS_REGISTRY.dndEnd.guard, byKey.get('dndEnd')?.textValue, DEFAULT_DND_SCHEDULE.end),
      days: safeParseDays(byKey.get('dndDays')?.textArrayValue),
    },
    timeZone: tz.timeZone,
    mobile: {
      decide: bool('notifyMobileDecide'),
      review: bool('notifyMobileReview'),
      finished: bool('notifyMobileFinished'),
      briefing: bool('notifyMobileBriefing'),
    },
    desktop: {
      decide: bool('notifyDesktopDecide'),
      review: bool('notifyDesktopReview'),
      finished: bool('notifyDesktopFinished'),
      briefing: bool('notifyDesktopBriefing'),
    },
    emailInvitations: bool('notifyEmailInvitations'),
    sound: safeParseString(SETTINGS_REGISTRY.notificationSound.guard, byKey.get('notificationSound')?.textValue, 'default'),
  }
}

export interface DesktopNotificationRuntime extends NotificationRuntimeSettings {
  legacyPushDecide: boolean | null
}

/** Desktop runtime policy plus legacy `pushDecide` fallback for `awaiting`/`failed` candidates. */
export async function readDesktopNotificationRuntime(userId: string): Promise<DesktopNotificationRuntime> {
  const [runtime, [legacy]] = await Promise.all([
    readNotificationRuntimeSettings(userId),
    db.select({ pushDecide: userPreferences.pushDecide }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
  ])
  return { ...runtime, legacyPushDecide: legacy?.pushDecide ?? null }
}
