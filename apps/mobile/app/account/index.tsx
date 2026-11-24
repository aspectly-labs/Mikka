import { Platform } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { mobileMessages } from '@/lib/messages'
import SettingsScreen from '../(tabs)/settings/index'

/**
 * 设置 opened from the sidebar trial's foot (lib/sidebar-trial.ts): the same screen as the 设置 tab, but pushed with no
 * tab under it and first in its own stack, so the system draws no back button; this close button takes its place.
 */
export default function AccountSettings() {
  const router = useRouter()
  return (
    <>
      {Platform.OS === 'ios' ? (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button icon="xmark" accessibilityLabel={mobileMessages.Common.close} onPress={() => router.back()} />
        </Stack.Toolbar>
      ) : null}
      <SettingsScreen />
    </>
  )
}
