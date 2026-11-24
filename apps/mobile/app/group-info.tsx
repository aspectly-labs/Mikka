import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { BotAvatar } from '@/components/icons'
import { NavBar, underBar } from '@/components/NavBar'
import { ReadNotice } from '@/components/ReadNotice'
import { Row } from '@/components/settings'
import { Text } from '@/components/Text'
import { Group } from '@/components/ui'
import { ListLoading } from '@/shared/components/empty-state'
import { mobileMessages } from '@/lib/messages'
import type { GroupMember, GroupSummary } from '@/lib/types'
import { useApi, useLiveApi, useRefresh } from '@/lib/useApi'
import { useHome } from '@/lib/home'
import { groupChatLive } from '@/lib/live-keys'
import { botPath } from '@/lib/pins'
import { colors } from '@/lib/theme'

/**
 * A group chat's 详情, opened from the ⓘ button in its bar, as a one-to-one chat opens its Bot's page (usability
 * audit C3: a group had no way to see who is in it). Reads the same members list the chat already reads.
 */
export default function GroupInfoScreen() {
  const { id, title, workspace } = useLocalSearchParams<{ id: string; title?: string; workspace?: string }>()
  const router = useRouter()
  const home = useHome().data
  // The group's workspace, read here as the chat reads it (cached), so the live key holds even when the page was opened
  // before the chat had it.
  const groups = useApi<{ conversations: GroupSummary[] }>(home ? `/api/conversations?workspaceId=${home.workspace.id}` : null)
  const workspaceId = groups.data?.conversations.find(group => group.id === id)?.workspaceId ?? workspace
  // The group's own live key, as the chat reads its members: a rename or a new member shows here too.
  const { data, error, loading, reload } = useLiveApi<{ members: GroupMember[] }>(`/api/conversations/${id}/members`, () => groupChatLive(id, workspaceId))
  // Only a Bot of the viewer's own opens a chat (a guest sees the owner's Bots read-only); the Coordinator opens by its
  // alias, so its unsent messages stay in one place. An archived Bot is not on Home either, so it stays read-only here.
  const own = new Map((home?.bots ?? []).map(bot => [bot.id, bot]))
  const refresh = useRefresh(reload)
  // Bots first (each opens its chat), then people.
  const members = data?.members ?? []
  const bots = members.filter(member => member.memberType !== 'user')
  const people = members.filter(member => member.memberType === 'user')
  const count = members.length
  return (
    <View style={styles.screen}>
      <NavBar title={title || mobileMessages.Shell.panel.details} />
      <ScrollView {...underBar} contentContainerStyle={styles.body} refreshControl={<RefreshControl {...refresh} />}>
        {loading && !data ? <ListLoading /> : null}
        <ReadNotice error={error} hasData={Boolean(data)} label={mobileMessages.Shell.panel.membersLoading} onRetry={reload} />
        {data ? (
          <Group label={mobileMessages.Shell.panel.members.replace('{count}', String(count))}>
            {bots.map(bot => (
              <Row key={`bot:${bot.id}`} icon={<BotAvatar color={bot.color} shape={bot.shape} size={28} />} label={bot.name} value={mobileMessages.MobileCore.groupInfo.bot}
                onPress={own.has(bot.id) ? () => router.push(botPath(own.get(bot.id)!)) : undefined} />
            ))}
            {people.map(person => (
              <Row key={`user:${person.id}`} icon={<View style={styles.person}><PersonInitial name={person.name} /></View>} label={person.name}
                value={mobileMessages.GroupChat.member} trailing={null} />
            ))}
          </Group>
        ) : null}
      </ScrollView>
    </View>
  )
}

function PersonInitial({ name }: { name: string }) {
  return <Text style={styles.initial}>{(name.trim()[0] ?? '?').toUpperCase()}</Text>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.grouped },
  body: { paddingTop: 8, paddingBottom: 40 },
  person: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 13, fontWeight: '600', color: colors.secondary },
})
