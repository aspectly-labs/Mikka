'use client'

import { useLayoutEffect, useState } from 'react'
import useSWR from 'swr'
import { useTheme } from 'next-themes'
import type { SettingsView } from '@mikka/protocol/settings'
import { patchPersonalSettings } from '@/app/actions/settings'
import {
  publishUiPreferences,
  readLocalUiPreferences,
  resolveUiPreferencesFromSettings,
  splitUiPreferencesPatch,
  writeLocalUiPreferences,
  type LocalUiPreferences,
  type UiPreferencesPatch,
} from '@/lib/ui-preferences'
import { fetchSettingsData, SettingsReadError, settingsReadOptions } from '@/lib/settings-data'
import { settingsKeys } from '@/lib/swr/keys'

/**
 * The signed-in person's interface and appearance settings, backed by P1 SETTINGS_REGISTRY
 * (`GET /api/settings/personal` + `patchPersonalSettings`). When `appearanceSync === false`,
 * per-device display mode and theme overrides stay in client localStorage only.
 */
export function useUiPreferences() {
  const [local, setLocal] = useState<LocalUiPreferences>(() => readLocalUiPreferences())
  const read = useSWR<SettingsView>(
    settingsKeys.personalRegistry(),
    () => fetchSettingsData<SettingsView>('/api/settings/personal'),
    settingsReadOptions,
  )
  const { resolvedTheme, setTheme } = useTheme()
  const unauthenticated = read.error instanceof SettingsReadError && read.error.status === 401
  const denied = read.error instanceof SettingsReadError && read.error.status === 403
  const { ui, sources } = resolveUiPreferencesFromSettings(read.data, local)

  useLayoutEffect(() => {
    if (read.data || Object.keys(local).length > 0) publishUiPreferences(ui)
  }, [read.data, local, ui, resolvedTheme])

  useLayoutEffect(() => {
    if (!read.data || !ui.appearanceSync) return
    setTheme(ui.colorScheme)
  }, [read.data, ui.appearanceSync, ui.colorScheme, setTheme])

  async function save(patch: UiPreferencesPatch) {
    const { registryValues, nextLocal, localChanged } = splitUiPreferencesPatch(patch, ui.appearanceSync, local)
    if (localChanged) {
      writeLocalUiPreferences(nextLocal)
      setLocal(nextLocal)
    }
    if (Object.keys(registryValues).length === 0) return null
    const result = await patchPersonalSettings({ values: registryValues })
    if ('error' in result && result.error) throw new Error(result.error)
    await read.mutate(result as SettingsView, { revalidate: false })
    return result
  }

  return {
    ui,
    sources,
    loading: read.isLoading && !read.data,
    failed: Boolean(read.error) && !unauthenticated && !denied,
    denied,
    reload: () => { void read.mutate() },
    save,
  }
}
