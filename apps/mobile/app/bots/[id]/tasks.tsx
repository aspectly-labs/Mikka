import { StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { NavBar } from '@/components/NavBar'
import { TaskList } from '@/features/tasks/components/task-list'
import { useHome } from '@/lib/home'
import { mobileMessages } from '@/lib/messages'
import { ListLoading } from '@/shared/components/empty-state'
import { ReadNotice } from '@/components/ReadNotice'
import { colors } from '@/lib/theme'

/** One bot's tasks, pushed over its chat (back returns to it); its threads are inside each task (2026-11-07). */
export default function BotTasks() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const home = useHome()
  const bots = home.data?.bots
  // The Coordinator's page is addressed as `coordinator`; its tasks carry its bot row's id.
  const bot = id === 'coordinator' ? bots?.find(item => item.coordinator) : bots?.find(item => item.id === id)
  return (
    <View style={styles.screen}>
      <NavBar title={mobileMessages.MobileCore.botTasks.replace('{name}', id === 'coordinator' ? 'Coordinator' : bot?.name ?? '')} />
      {/* Until the bots are read the list cannot know whose tasks to show: a spinner, not 「没有任务」 (#1). */}
      {bots ? <TaskList bot={bot?.id ?? null} /> : home.error ? <ReadNotice error={home.error} hasData={false} label={mobileMessages.Nav.tasks} onRetry={home.reload} /> : <ListLoading />}
    </View>
  )
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.page } })
