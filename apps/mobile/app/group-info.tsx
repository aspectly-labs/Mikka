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
import type { GroupMember } from '@/lib/types'
import { useApi, useRefresh } from '@/lib/useApi'
import { colors } from '@/lib/theme'

/**
 * A group chat's 详情, opened from the ⓘ button in its bar, as a one-to-one chat opens its Bot's page (usability
 * audit C3: a group had no way to see who is in it). Reads the same members list the chat already reads.
 */
export default function GroupInfoScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>()
  const router = useRouter()
  const { data, error, loading, reload } = useApi<{ members: GroupMember[] }>(`/api/conversations/${id}/members`)
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
              <Row key={`bot:${bot.id}`} icon={<BotAvatar color={bot.color} shape={bot.shape} size={28} />} label={bot.name} value="Bot"
                onPress={() => router.push({ pathname: '/bots/[id]', params: { id: bot.id } })} />
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
