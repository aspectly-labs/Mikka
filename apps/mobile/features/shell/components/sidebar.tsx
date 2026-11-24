import { useCallback, useState, type ReactNode } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { type Href, usePathname, useRouter } from 'expo-router'
import { Drawer } from 'react-native-drawer-layout'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BotAvatar } from '@/components/icons'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { botPath } from '@/lib/pins'
import { useSidebarTrial } from '@/lib/sidebar-trial'
import { colors } from '@/lib/theme'
import { mobileMessages } from '@/lib/messages'
import { useHomeChats, type HomeChat } from '@/features/home/model/use-home-chats'

/** The tab roots: only there does a swipe to the right open the sidebar; on a pushed page it stays the back swipe. */
const TAB_ROOTS = new Set(['/', '/tasks', '/suggestions', '/settings', '/search'])

/**
 * The sidebar trial (lib/sidebar-trial.ts): with the switch off it renders the tabs and nothing else. With it on, the
 * tabs sit in react-native-drawer-layout configured as Bluesky's app does: on iOS the content slides right with the
 * drawer (only a transform moves), a swipe to the right anywhere on a tab root opens it, and any movement to the left
 * is left to the page (a row's pin swipe).
 */
export function SidebarDrawer({ children }: { children: ReactNode }) {
  const trial = useSidebarTrial()
  if (!trial || Platform.OS === 'web') return <>{children}</>
  return <SidebarShell>{children}</SidebarShell>
}

function SidebarShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const atRoot = TAB_ROOTS.has(usePathname())
  const { width } = useWindowDimensions()
  const onOpen = useCallback(() => setOpen(true), [])
  const onClose = useCallback(() => setOpen(false), [])
  const go = useCallback((href: Href) => { setOpen(false); router.push(href) }, [router])
  const renderDrawerContent = useCallback(() => <SidebarContent go={go} />, [go])
  return (
    <Drawer
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      renderDrawerContent={renderDrawerContent}
      drawerType={Platform.OS === 'ios' ? 'slide' : 'front'}
      drawerStyle={{ width: Math.min(400, width * 0.8), backgroundColor: colors.grouped }}
      overlayStyle={{ backgroundColor: 'rgba(0, 0, 0, 0.08)' }}
      swipeEdgeWidth={width}
      swipeMinVelocity={100}
      swipeMinDistance={10}
      configureGestureHandler={handler => {
        if (!atRoot) return { ...handler, onBegin: undefined, failOffsetX: [0, 0], failOffsetY: [0, 0] }
        if (open) return { ...handler, activeOffsetX: [-1, 1] }
        // Any movement to the left belongs to the page; a movement to the right claims the drawer after 5 points.
        return { ...handler, failOffsetX: -1, activeOffsetX: Platform.OS === 'android' ? 20 : 5 }
      }}>
      {children}
    </Drawer>
  )
}

/** The sidebar's places, drawn once and kept while it slides: 全部, then the bots and the group chats, then 新建. */
function SidebarContent({ go }: { go: (href: Href) => void }) {
  const insets = useSafeAreaInsets()
  const { chats } = useHomeChats()
  const shown = chats.filter(chat => !chat.hidden)
  const bots = shown.filter(chat => chat.row.kind === 'bot').sort((a, b) => Number(b.coordinator) - Number(a.coordinator))
  const groups = shown.filter(chat => chat.row.kind === 'group')
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
      <Place label="全部" onPress={() => go('/tasks')}
        icon={<View style={styles.allIcon}><Symbol name="square.stack.3d.up.fill" size={17} color="#fff" /></View>} />
      {bots.length ? <Text style={styles.section}>Bot</Text> : null}
      {bots.map(chat => <ChatPlace key={chat.key} chat={chat} go={go} />)}
      {groups.length ? <Text style={styles.section}>群聊</Text> : null}
      {groups.map(chat => <ChatPlace key={chat.key} chat={chat} go={go} />)}
      <View style={styles.gap} />
      <Place label="新建 Bot" onPress={() => go('/new-bot')} icon={<Symbol name="plus" size={17} color={colors.accent} />} accent />
      <Place label="新建群聊" onPress={() => go('/new-group')} icon={<Symbol name="person.2" size={17} color={colors.accent} />} accent />
    </ScrollView>
  )
}

function ChatPlace({ chat, go }: { chat: HomeChat; go: (href: Href) => void }) {
  const row = chat.row
  if (row.kind === 'bot') {
    return <Place label={row.bot.name} detail={row.bot.working ? mobileMessages.Issue.status.doing : undefined}
      icon={<BotAvatar id={row.bot.id} coordinator={row.bot.coordinator} color={row.bot.color} shape={row.bot.shape} size={32} />}
      onPress={() => go(botPath(row.bot))} />
  }
  return <Place label={row.group.title} icon={<View style={styles.groupIcon}><Symbol name="person.2.fill" size={14} color={colors.secondary} /></View>}
    onPress={() => go(`/groups/${row.group.id}`)} />
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
})
