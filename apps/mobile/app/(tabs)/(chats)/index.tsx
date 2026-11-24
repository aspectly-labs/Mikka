import { HomeScreen } from '@/features/home/screens/home-screen'
import { SidebarChat } from '@/features/shell/components/sidebar-chat'
import { useSidebarTrial } from '@/lib/sidebar-trial'
import { Platform } from 'react-native'

/** The app opens on the chat list, the home screen (#1408 Phase 2). With 试用侧边栏 on (iOS), this tab is the chat of the bot picked in the sidebar. */
export default function ChatsHome() {
  const trial = useSidebarTrial()
  return trial && Platform.OS === 'ios' ? <SidebarChat /> : <HomeScreen />
}
