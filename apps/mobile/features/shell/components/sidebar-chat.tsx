import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ChatScreen } from '@/features/chat/screens/chat-screen'
import { ModelMenu } from '@/components/ModelMenu'
import { ModelNotice } from '@/components/ModelNotice'
import { useHome } from '@/lib/home'
import { useModelMenu } from '@/lib/model-menu'
import { useSidebarBot } from '@/lib/sidebar-trial'

/**
 * The sidebar trial's 聊天 tab: the chat of the bot picked in the sidebar, the Coordinator's until one is picked, as
 * app/bots/[id] draws it. Its own safe-area provider measures the tab's view, so the composer sits above the tab bar.
 */
export function SidebarChat() {
  const id = useSidebarBot()
  const bot = useHome().data?.bots.find(item => item.id === id)
  const model = useModelMenu(id)
  const composer = { composerAccessory: (running: boolean) => <ModelMenu model={model} running={running} />, composerNotice: <ModelNotice model={model} /> }
  return (
    <SafeAreaProvider>
      {id && bot ? <ChatScreen botId={id} name={bot.name} color={bot.color} shape={bot.shape} {...composer} />
        : <ChatScreen botId={null} name="Coordinator" {...composer} />}
    </SafeAreaProvider>
  )
}
