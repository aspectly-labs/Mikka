import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { uuid } from 'expo'
import { Spinner } from '@/components/icons'
import { apiCache } from '@/lib/api-cache'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp } from 'lucide-react-native'
import { Markdown } from '@/components/Markdown'
import { SettingsPage } from '@/components/settings'
import { Text } from '@/components/Text'
import { eveChatClient } from '@/lib/eve-client'
import { openChat } from '@/lib/navigate'
import { useSettings } from '@/lib/settings'
import { colors, font, lift } from '@/lib/theme'
import { mobileMessages } from '@/lib/messages'

/** 记忆摘要: one Markdown document with an ask-or-update input (ChatGPT 记忆摘要; Alex 2026-10-27). */
export default function MemorySummaryScreen() {
  const insets = useSafeAreaInsets()
  const { data } = useSettings()
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false), mounted = useRef(true), focused = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useFocusEffect(useCallback(() => {
    focused.current = true
    return () => { focused.current = false }
  }, []))
  const submission = useRef<{ text: string; id: string; context: number } | null>(null)
  // Asking or updating goes to the Coordinator, which keeps the memory; its answer is in the chat.
  const ask = async () => {
    const value = text.trim()
    if (!value || sending.current) return
    const context = apiCache.context()
    if (submission.current?.text !== value || submission.current.context !== context) submission.current = { text: value, id: uuid.v4(), context }
    sending.current = true; setBusy(true); setFailed(false)
    // A retry reuses one submission identity when the response was lost.
    try {
      const { session } = await eveChatClient().sessions.create()
      await session.send(mobileMessages.MobileCore.memory.askPrompt.replace('{value}', () => value), { headers: { 'x-mikka-submission-id': submission.current.id } })
      apiCache.commit(context, () => {
        if (!mounted.current) return
        setText(current => current.trim() === value ? '' : current)
        submission.current = null
        // A covered screen can remain mounted; do not replace the newer route.
        if (focused.current) openChat('/bots/coordinator')
      })
    } catch { apiCache.commit(context, () => setFailed(true)) }
    finally { sending.current = false; setBusy(false) }
  }
  return (
    <SettingsPage
      title={mobileMessages.MobileCore.memory.summary}
      footer={
        <View style={[styles.askWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {failed ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.failed}>{mobileMessages.MobileCore.memory.sendUnconfirmed}</Text> : null}
          <View style={styles.ask}>
            <TextInput accessibilityLabel={mobileMessages.MobileCore.memory.askLabel} editable={!busy} value={text} onChangeText={setText} onSubmitEditing={() => void ask()} placeholder={mobileMessages.MobileCore.memory.askPlaceholder} placeholderTextColor={colors.secondary} style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel={busy ? mobileMessages.MobileCore.memory.sending : mobileMessages.Coordinator.send} accessibilityState={{ busy, disabled: busy || !text.trim() }} disabled={busy || !text.trim()} onPress={() => void ask()} style={({ pressed }) => [styles.send, text.trim() ? { backgroundColor: colors.accentFill } : null, pressed && { opacity: 0.7 }]}>
              {busy ? <Spinner size={20} color={colors.onAccent} /> : <ArrowUp size={20} color={colors.onAccent} strokeWidth={2.4} />}
            </Pressable>
          </View>
        </View>
      }
    >
      {data?.memory ? <Markdown text={data.memory} /> : <Text style={styles.text}>{mobileMessages.MobileCore.memory.empty}</Text>}
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 26 },
  askWrap: { paddingHorizontal: 16, paddingTop: 8, gap: 6 },
  failed: { fontSize: 13, color: colors.danger, marginLeft: 18 },
  ask: { flexDirection: 'row', alignItems: 'center', minHeight: 56, borderRadius: 26, backgroundColor: colors.surface, paddingLeft: 18, paddingRight: 6, ...lift },
  input: { flex: 1, minWidth: 0, width: 0, color: colors.text, minHeight: 44, fontFamily: font, fontSize: 16, outlineStyle: 'none' } as never,
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.tertiary, alignItems: 'center', justifyContent: 'center' },
})
