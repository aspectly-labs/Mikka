import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { type Href, usePathname, useRouter } from 'expo-router'
import DrawerLayout, { DrawerLockMode, DrawerType, type DrawerLayoutMethods } from 'react-native-gesture-handler/ReanimatedDrawerLayout'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar, Spinner } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { useHome } from '@/lib/home'
import { listRef } from '@/lib/live'
import type { HomeBot } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { setSidebarBot, useSidebarTrial } from '@/lib/sidebar-trial'
import { colors } from '@/lib/theme'
import { mobileMessages } from '@/lib/messages'
import { useHomeChats } from '@/features/home/model/use-home-chats'
import { directoryConversationKey, type ConversationDirectoryPage } from '../../../../../lib/conversation-directory-input'

/** The tab roots: only there does a swipe to the right open the sidebar; on a pushed page it stays the back swipe. */
const TAB_ROOTS = new Set(['/', '/tasks', '/suggestions', '/settings', '/search'])

/**
 * The sidebar trial (lib/sidebar-trial.ts): with the switch off it renders the tabs and nothing else. With it on, the
 * tabs sit in Gesture Handler's own Reanimated drawer, set up the way Bluesky's app sets its drawer: on iOS the
 * content slides right with the drawer (only a transform moves, on the UI thread), a swipe to the right anywhere on a
 * tab root opens it after 5 points, and pushed pages keep the system back swipe because the drawer is locked there.
 */
export function SidebarDrawer({ children }: { children: ReactNode }) {
  const trial = useSidebarTrial()
  if (!trial || Platform.OS !== 'ios') return <>{children}</>
  return <SidebarShell>{children}</SidebarShell>
}

function SidebarShell({ children }: { children: ReactNode }) {
  const drawer = useRef<DrawerLayoutMethods>(null)
  const router = useRouter()
  const atRoot = TAB_ROOTS.has(usePathname())
  const { width } = useWindowDimensions()
  const close = useCallback(() => drawer.current?.closeDrawer(), [])
  const go = useCallback((href: Href) => { drawer.current?.closeDrawer(); router.push(href) }, [router])
  const renderNavigationView = useCallback(() => <SidebarContent go={go} close={close} />, [close, go])
  return (
    <DrawerLayout
      ref={drawer}
      renderNavigationView={renderNavigationView}
      drawerType={DrawerType.SLIDE}
      drawerWidth={Math.min(400, width * 0.8)}
      drawerBackgroundColor={colors.grouped}
      overlayColor="rgba(0, 0, 0, 0.08)"
      edgeWidth={width}
      minSwipeDistance={5}
      drawerLockMode={atRoot ? DrawerLockMode.UNLOCKED : DrawerLockMode.LOCKED_CLOSED}>
      {children}
    </DrawerLayout>
  )
}

/**
 * The sidebar's places (Alex 2026-11-24: Bot, with its threads folded under it): the bots with the Coordinator first,
 * each opening its chat in the 聊天 tab and unfolding its threads, then the group chats and 新建.
 */
function SidebarContent({ go, close }: { go: (href: Href) => void; close: () => void }) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { chats } = useHomeChats()
  const workspaceId = useHome().data?.workspace.id
  const shown = chats.filter(chat => !chat.hidden)
  const bots = shown.filter(chat => chat.row.kind === 'bot').sort((a, b) => Number(b.coordinator) - Number(a.coordinator))
  const groups = shown.filter(chat => chat.row.kind === 'group')
  const openChat = (bot: HomeBot) => { setSidebarBot(bot.coordinator ? null : bot.id); close(); router.navigate('/') }
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
      {bots.length ? <Text style={styles.section}>{mobileMessages.Nav.bots}</Text> : null}
      {bots.map(chat => chat.row.kind === 'bot' ? <BotPlace key={chat.key} bot={chat.row.bot} workspaceId={workspaceId} onOpen={openChat} go={go} /> : null)}
      {groups.length ? <Text style={styles.section}>{mobileMessages.MobileCore.groupChats}</Text> : null}
      {groups.map(chat => chat.row.kind === 'group' ? <Place key={chat.key} label={chat.row.group.title}
        icon={<View style={styles.groupIcon}><Symbol name="person.2.fill" size={14} color={colors.secondary} /></View>}
        onPress={() => go(`/groups/${chat.key}`)} /> : null)}
      <View style={styles.gap} />
      <Place label={mobileMessages.Nav.newBot} onPress={() => go('/new-bot')} icon={<Symbol name="plus" size={17} color={colors.accent} />} accent />
      <Place label={mobileMessages.Nav.newGroup} onPress={() => go('/new-group')} icon={<Symbol name="person.2" size={17} color={colors.accent} />} accent />
    </ScrollView>
  )
}

type BotThreads = Pick<ConversationDirectoryPage, 'items'> & { workspaceId: string; botId: string; more: boolean }

/** A bot: its row opens its chat; the chevron folds its threads in and out, read only while unfolded. */
function BotPlace({ bot, workspaceId, onOpen, go }: { bot: HomeBot; workspaceId?: string; onOpen: (bot: HomeBot) => void; go: (href: Href) => void }) {
  const [open, setOpen] = useState(false)
  const toggle = () => { tap(); setOpen(value => !value) }
  return (
    <View>
      <View style={styles.botRow}>
        <View style={styles.fill}>
          <Place label={bot.name} detail={bot.working ? mobileMessages.Issue.status.doing : undefined}
            icon={<BotAvatar id={bot.id} coordinator={bot.coordinator} color={bot.color} shape={bot.shape} size={32} />}
            onPress={() => onOpen(bot)} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={open ? mobileMessages.Nav.botMenu.hideThreads : mobileMessages.Nav.botMenu.showThreads}
          accessibilityState={{ expanded: open }} hitSlop={6} onPress={toggle} style={({ pressed }) => [styles.chevron, pressed && { backgroundColor: colors.pressed }]}>
          <Symbol name={open ? 'chevron.down' : 'chevron.right'} size={13} color={colors.secondary} />
        </Pressable>
      </View>
      {open ? <BotThreadList botId={bot.id} workspaceId={workspaceId} go={go} /> : null}
    </View>
  )
}

function BotThreadList({ botId, workspaceId, go }: { botId: string; workspaceId?: string; go: (href: Href) => void }) {
  const path = workspaceId ? '/api/mobile/conversations?' + new URLSearchParams({ view: 'botChildren', workspaceId, botId }) : null
  const read = useLiveApi<BotThreads>(path, () => ({ refs: [listRef('thread_list', workspaceId), listRef('group_list', workspaceId)], minIntervalMs: 2_000 }))
  const items = read.data && read.data.botId === botId ? read.data.items : null
  if (!items) return <View style={styles.threadsLoading}><Spinner /></View>
  return (
    <View style={styles.threads}>
      {items.map(item => (
        <Pressable key={directoryConversationKey(item)} accessibilityRole="button" onPress={() => go(item.kind === 'chat' ? `/groups/${item.id}` : `/thread/${item.id}`)}
          style={({ pressed }) => [styles.thread, pressed && { backgroundColor: colors.pressed }]}>
          <Text style={styles.threadTitle} numberOfLines={1}>{item.title || mobileMessages.Nav.untitledConversation}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function Place({ label, detail, icon, onPress, accent }: { label: string; detail?: string; icon: ReactNode; onPress: () => void; accent?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={detail ? `${label}，${detail}` : label} onPress={onPress}
      style={({ pressed }) => [styles.place, pressed && { backgroundColor: colors.pressed }]}>
      {icon}
      <Text style={[styles.label, accent && { color: colors.accent }]} numberOfLines={1}>{label}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 10, gap: 2 },
  place: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 10, borderRadius: 12, borderCurve: 'continuous' },
  label: { flex: 1, fontSize: 17, lineHeight: 22 },
  detail: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  section: { fontSize: 13, lineHeight: 18, color: colors.secondary, paddingHorizontal: 10, paddingTop: 20, paddingBottom: 6 },
  allIcon: { width: 32, height: 32, borderRadius: 9, borderCurve: 'continuous', backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  groupIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center' },
  gap: { height: 16 },
  botRow: { flexDirection: 'row', alignItems: 'center' },
  fill: { flex: 1, minWidth: 0 },
  chevron: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  threads: { paddingLeft: 54, paddingBottom: 6 },
  threadsLoading: { paddingLeft: 54, paddingVertical: 10, alignItems: 'flex-start' },
  thread: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 10, borderCurve: 'continuous' },
  threadTitle: { fontSize: 15, lineHeight: 20, color: colors.secondary },
})
