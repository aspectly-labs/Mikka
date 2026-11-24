import { useState, useSyncExternalStore } from 'react'
import { ScrollView, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Check } from 'lucide-react-native'
import { NavBar, underBar } from '@/components/NavBar'
import { Row, Avatar } from '@/components/settings'
import { Text } from '@/components/Text'
import { Symbol } from '@/components/Symbol'
import { Group } from '@/components/ui'
import { servers } from '@/lib/config'
import { addMobileAccount, selectMobileAccount } from '@/lib/server-actions'
import { serverCopy as copy } from '@/lib/server-copy'
import { colors } from '@/lib/theme'

export default function AccountsScreen() {
  const state = useSyncExternalStore(servers.subscribe, servers.snapshot, servers.snapshot)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const change = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setFailed(false)
    try { await work(); router.replace('/') }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <View style={{ flex: 1, backgroundColor: colors.grouped }}>
    <NavBar title={copy.accounts} back={() => router.back()} />
    <ScrollView {...underBar} contentContainerStyle={{ padding: 16 }}>
      <Group>{state.accounts.filter(account => account.user).map(account => <Row key={account.id}
        icon={<Avatar name={account.user!.name || account.user!.email} image={null} size={36} />}
        label={account.user!.email} detail={`${account.server.name} · ${account.server.url}`} disabled={busy}
        trailing={account.id === state.active ? <Symbol name="checkmark" size={17} color={colors.accent} web={<Check size={20} color={colors.accent} strokeWidth={2.4} />} /> : null}
        onPress={() => { if (account.id !== state.active) void change(() => selectMobileAccount(account.id)) }} />)}</Group>
      <Group><Row label={copy.addAccount} disabled={busy} onPress={() => void change(addMobileAccount)} /></Group>
      {failed ? <Text selectable accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 13, marginLeft: 16 }}>{copy.switchFailed}</Text> : null}
    </ScrollView>
  </View>
}
