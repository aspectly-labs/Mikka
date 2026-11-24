import { Platform } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { mobileMessages } from '@/lib/messages'

/** A page opened from the sidebar is first in its own stack, so the system draws no back button: ✕ takes its place. */
export function BrowseClose() {
  const router = useRouter()
  if (Platform.OS !== 'ios') return null
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel={mobileMessages.Common.close} onPress={() => router.back()} />
    </Stack.Toolbar>
  )
}
