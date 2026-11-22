'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import type { ResolvedSetting, SettingValue, SettingsView } from '@mikka/protocol/settings'
import { patchPersonalSettings } from '@/app/actions/settings'
import { useNotificationSettings } from '@/hooks/settings/use-notification-settings'
import type { Preferences } from '@/lib/preferences'
import {
  DEFAULT_DND_SCHEDULE,
  DND_DAYS,
  DND_TIME_PATTERN,
  NOTIFICATION_SOUNDS,
  type DndDay,
  type DndSchedule,
  type NotificationChannel,
  type NotificationSound,
} from '@/lib/push-allowed'
import type { PushReason } from '@/lib/push-reasons'
import { fetchSettingsData, SettingsReadError, settingsReadOptions } from '@/lib/settings-data'
import { settingsKeys } from '@/lib/swr/keys'

export {
  DEFAULT_DND_SCHEDULE,
  DND_DAYS,
  DND_TIME_PATTERN,
  NOTIFICATION_SOUNDS,
  type DndDay,
  type DndSchedule,
  type NotificationChannel,
  type NotificationSound,
  type PushReason,
}

export const NOTIFICATION_CATEGORIES = ['decide', 'review', 'finished', 'briefing'] as const satisfies readonly PushReason[]

export const DND_TIME_OPTIONS: readonly string[] = Array.from({ length: 48 }, (_, index) => {
  const hours = String(Math.floor(index / 2)).padStart(2, '0')
  const minutes = index % 2 === 0 ? '00' : '30'
  return `${hours}:${minutes}`
})

export type BrowserPushPermission = 'granted' | 'denied' | 'default' | 'unsupported'
export type TestNotificationStatus = 'sent' | 'playedSound' | 'silent'

export type NotificationRegistryKey =
  | 'dndEnabled'
  | 'dndStart'
  | 'dndEnd'
  | 'dndDays'
  | 'notifyMobileDecide'
  | 'notifyMobileReview'
  | 'notifyMobileFinished'
  | 'notifyMobileBriefing'
  | 'notifyDesktopDecide'
  | 'notifyDesktopReview'
  | 'notifyDesktopFinished'
  | 'notifyDesktopBriefing'
  | 'notifyEmailInvitations'
  | 'notificationSound'

const CHANNEL_REASON_KEYS: Record<NotificationChannel, Record<PushReason, NotificationRegistryKey>> = {
  mobile: {
    decide: 'notifyMobileDecide',
    review: 'notifyMobileReview',
    finished: 'notifyMobileFinished',
    briefing: 'notifyMobileBriefing',
  },
  desktop: {
    decide: 'notifyDesktopDecide',
    review: 'notifyDesktopReview',
    finished: 'notifyDesktopFinished',
    briefing: 'notifyDesktopBriefing',
  },
}

const LEGACY_PREFERENCE_KEY: Record<PushReason, keyof Pick<Preferences, 'pushDecide' | 'pushReview' | 'pushFinished' | 'pushBriefing'>> = {
  decide: 'pushDecide',
  review: 'pushReview',
  finished: 'pushFinished',
  briefing: 'pushBriefing',
}

function readBrowserPermission(): BrowserPushPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  const perm = window.Notification.permission
  return perm === 'granted' || perm === 'denied' ? perm : 'default'
}

function resolveBooleanWithLegacy(entry: ResolvedSetting | undefined, legacyValue: boolean | undefined, fallback = true): boolean {
  if (entry?.source === 'personal' && typeof entry.value === 'boolean') return entry.value
  if (typeof legacyValue === 'boolean') return legacyValue
  if (typeof entry?.value === 'boolean') return entry.value
  return fallback
}

function resolveTime(entry: ResolvedSetting | undefined, fallback: string): string {
  return typeof entry?.value === 'string' && DND_TIME_PATTERN.test(entry.value) ? entry.value : fallback
}

function resolveDays(entry: ResolvedSetting | undefined): DndDay[] {
  if (!Array.isArray(entry?.value)) return [...DEFAULT_DND_SCHEDULE.days]
  const valid = entry.value.filter((day): day is DndDay => (DND_DAYS as readonly string[]).includes(day))
  return DND_DAYS.filter(day => valid.includes(day))
}

function resolveSound(entry: ResolvedSetting | undefined): NotificationSound {
  return typeof entry?.value === 'string' && (NOTIFICATION_SOUNDS as readonly string[]).includes(entry.value)
    ? (entry.value as NotificationSound)
    : 'default'
}

export interface ResolvedNotificationMatrix {
  dnd: {
    enabled: boolean
    start: string
    end: string
    days: DndDay[]
  }
  mobile: Record<PushReason, boolean>
  desktop: Record<PushReason, boolean>
  emailInvitations: boolean
  sound: NotificationSound
}

export function resolveNotificationMatrixFromSettings(
  settings: SettingsView | undefined,
  legacy?: Partial<Pick<Preferences, 'pushDecide' | 'pushReview' | 'pushFinished' | 'pushBriefing' | 'organizationInvitationEmails'>> | null,
): ResolvedNotificationMatrix {
  const values = settings?.values
  const dndEnabledEntry = values?.dndEnabled
  return {
    dnd: {
      enabled: typeof dndEnabledEntry?.value === 'boolean' ? dndEnabledEntry.value : DEFAULT_DND_SCHEDULE.enabled,
      start: resolveTime(values?.dndStart, DEFAULT_DND_SCHEDULE.start),
      end: resolveTime(values?.dndEnd, DEFAULT_DND_SCHEDULE.end),
      days: resolveDays(values?.dndDays),
    },
    mobile: {
      decide: resolveBooleanWithLegacy(values?.notifyMobileDecide, legacy?.pushDecide),
      review: resolveBooleanWithLegacy(values?.notifyMobileReview, legacy?.pushReview),
      finished: resolveBooleanWithLegacy(values?.notifyMobileFinished, legacy?.pushFinished),
      briefing: resolveBooleanWithLegacy(values?.notifyMobileBriefing, legacy?.pushBriefing),
    },
    desktop: {
      decide: resolveBooleanWithLegacy(values?.notifyDesktopDecide, legacy?.pushDecide),
      review: resolveBooleanWithLegacy(values?.notifyDesktopReview, legacy?.pushReview),
      finished: resolveBooleanWithLegacy(values?.notifyDesktopFinished, legacy?.pushFinished),
      briefing: resolveBooleanWithLegacy(values?.notifyDesktopBriefing, legacy?.pushBriefing),
    },
    emailInvitations: resolveBooleanWithLegacy(values?.notifyEmailInvitations, legacy?.organizationInvitationEmails),
    sound: resolveSound(values?.notificationSound),
  }
}

/** Synthesizes a short built-in Web Audio preview tone for `default`, `subtle`, or `chime`. */
export function playNotificationPreview(sound: NotificationSound): boolean {
  if (sound === 'none' || typeof window === 'undefined') return false
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return false
  try {
    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const notes = sound === 'chime' ? [659.25, 880, 1046.5] : sound === 'subtle' ? [440] : [523.25, 659.25]
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = sound === 'subtle' ? 'sine' : 'triangle'
      osc.frequency.setValueAtTime(freq, now + index * 0.09)
      gain.gain.setValueAtTime(0.001, now + index * 0.09)
      gain.gain.exponentialRampToValueAtTime(sound === 'subtle' ? 0.08 : 0.14, now + index * 0.09 + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.09 + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + index * 0.09)
      osc.stop(now + index * 0.09 + 0.2)
    })
    window.setTimeout(() => { void ctx.close().catch(() => {}) }, 600)
    return true
  } catch {
    return false
  }
}

function applyOptimisticValues(current: SettingsView | undefined, patch: Record<string, SettingValue>): SettingsView {
  const baseValues = { ...current?.values }
  for (const [key, value] of Object.entries(patch)) {
    baseValues[key] = { value, source: 'personal' }
  }
  return {
    workspaceId: current?.workspaceId ?? '',
    values: baseValues,
    workCreation: current?.workCreation ?? { configured: { value: 'private', source: 'workspace' }, effectiveVisibility: 'private', privateAllowed: true, reason: 'personal_workspace' },
  }
}

/**
 * Unified Frame 07 Notification controller combining `WS-C` `SETTINGS_REGISTRY` personal keys
 * (`dnd*`, `notifyMobile*`, `notifyDesktop*`, `notifyEmailInvitations`, `notificationSound`),
 * legacy `useNotificationSettings` (`proactive`, `pushWhen`), and browser Notification permission.
 */
export function useNotificationMatrix() {
  const legacy = useNotificationSettings()
  const registry = useSWR<SettingsView>(
    settingsKeys.personalRegistry(),
    () => fetchSettingsData<SettingsView>('/api/settings/personal'),
    settingsReadOptions,
  )
  const [failedPatch, setFailedPatch] = useState<Record<string, SettingValue> | null>(null)
  const [browserPermission, setBrowserPermission] = useState<BrowserPushPermission>(() => readBrowserPermission())
  const [requestingPermission, setRequestingPermission] = useState(false)
  const [testStatus, setTestStatus] = useState<TestNotificationStatus | null>(null)

  useEffect(() => {
    setBrowserPermission(readBrowserPermission())
  }, [])

  const unauthenticated = registry.error instanceof SettingsReadError && registry.error.status === 401
  const loading = (!registry.data && registry.isLoading) || (!legacy.data && !legacy.error)
  const loadError = (Boolean(registry.error) && !unauthenticated && !registry.data) || Boolean(legacy.error)
  const matrix = resolveNotificationMatrixFromSettings(registry.data, legacy.data)

  async function saveRegistry(patch: Partial<Record<NotificationRegistryKey, SettingValue>>) {
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter((entry): entry is [string, SettingValue] => entry[1] !== undefined),
    )
    if (Object.keys(cleanPatch).length === 0) return
    setFailedPatch(null)
    try {
      await registry.mutate(
        async () => {
          const result = await patchPersonalSettings({ values: cleanPatch })
          if ('error' in result && result.error) throw new Error(result.error)
          return result as SettingsView
        },
        {
          optimisticData: applyOptimisticValues(registry.data, cleanPatch),
          rollbackOnError: true,
          revalidate: false,
        },
      )
    } catch {
      setFailedPatch(cleanPatch)
    }
  }

  function setDndEnabled(enabled: boolean) {
    void saveRegistry({ dndEnabled: enabled })
  }

  function setDndStart(start: string) {
    if (!DND_TIME_PATTERN.test(start) || start === matrix.dnd.start) return
    void saveRegistry({ dndStart: start })
  }

  function setDndEnd(end: string) {
    if (!DND_TIME_PATTERN.test(end) || end === matrix.dnd.end) return
    void saveRegistry({ dndEnd: end })
  }

  function toggleDndDay(day: DndDay) {
    const active = new Set(matrix.dnd.days)
    if (active.has(day)) active.delete(day)
    else active.add(day)
    const nextDays = DND_DAYS.filter(item => active.has(item))
    void saveRegistry({ dndDays: nextDays })
  }

  function setChannelCategory(channel: NotificationChannel, reason: PushReason, enabled: boolean) {
    const key = CHANNEL_REASON_KEYS[channel][reason]
    void saveRegistry({ [key]: enabled })
  }

  function setEmailInvitations(enabled: boolean) {
    void saveRegistry({ notifyEmailInvitations: enabled })
  }

  function setSound(sound: NotificationSound) {
    if (!(NOTIFICATION_SOUNDS as readonly string[]).includes(sound)) return
    void saveRegistry({ notificationSound: sound })
  }

  async function enableBrowserPush() {
    if (typeof window === 'undefined' || !('Notification' in window) || requestingPermission) return
    setRequestingPermission(true)
    try {
      const next = await window.Notification.requestPermission()
      setBrowserPermission(next === 'granted' || next === 'denied' ? next : 'default')
    } catch {
      setBrowserPermission(readBrowserPermission())
    } finally {
      setRequestingPermission(false)
    }
  }

  function sendTestNotification(title: string, body: string) {
    const played = playNotificationPreview(matrix.sound)
    const perm = readBrowserPermission()
    setBrowserPermission(perm)
    if (perm === 'granted' && typeof window !== 'undefined' && 'Notification' in window) {
      try {
        new window.Notification(title, { body, silent: matrix.sound === 'none' })
        setTestStatus('sent')
        return
      } catch {
        // Fall through to sound status when Notification constructor is restricted.
      }
    }
    setTestStatus(played ? 'playedSound' : 'silent')
  }

  const saveFailed = Boolean(failedPatch) || Boolean(legacy.failed)
  function retrySave() {
    if (failedPatch) void saveRegistry(failedPatch as Partial<Record<NotificationRegistryKey, SettingValue>>)
    if (legacy.failed) legacy.retry()
  }

  function reload() {
    void registry.mutate()
    void legacy.reload()
  }

  return {
    loading,
    loadError,
    matrix,
    proactive: legacy.data?.proactive ?? true,
    pushWhen: legacy.data?.pushWhen ?? 'always',
    setProactive: (enabled: boolean) => { void legacy.set({ proactive: enabled }) },
    setPushWhen: (pushWhen: 'always' | 'away') => { void legacy.set({ pushWhen }) },
    setDndEnabled,
    setDndStart,
    setDndEnd,
    toggleDndDay,
    setChannelCategory,
    setEmailInvitations,
    setSound,
    browserPermission,
    requestingPermission,
    enableBrowserPush,
    testStatus,
    sendTestNotification,
    saveFailed,
    retrySave,
    reload,
    legacyFlagKey: LEGACY_PREFERENCE_KEY,
  }
}
