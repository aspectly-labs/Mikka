import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSettingsPath } from '@/lib/sidebar-trial'
import { Row, SettingsPage, ToggleRow } from '@/components/settings'
import { Group } from '@/components/ui'
import { PreferenceSaveNotice } from '@/components/PreferenceSaveNotice'
import { useSettings } from '@/lib/settings'
import { mobileMessages } from '@/lib/messages'

/** 记忆 (ChatGPT, Claude): the switch, and the summary as one Markdown document. */
export default function MemoryScreen() {
  const router = useRouter()
  const settingsPath = useSettingsPath()
  const { data, savePreferences, preferenceSave } = useSettings()
  if (!data) return <SettingsPage title={mobileMessages.Settings.sections.memory.title}><View /></SettingsPage>
  return (
    <SettingsPage title={mobileMessages.Settings.sections.memory.title}>
      <Group><ToggleRow label={mobileMessages.Settings.memory.enabled} value={data.preferences.memoryEnabled} disabled={preferenceSave.status !== 'idle'} onChange={memoryEnabled => void savePreferences({ memoryEnabled })} /></Group>
      <PreferenceSaveNotice />
      <Group><Row label={mobileMessages.MobileCore.memory.summary} onPress={() => router.push(settingsPath('memory-summary'))} /></Group>
    </SettingsPage>
  )
}
