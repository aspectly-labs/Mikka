import { randomUUID } from 'expo-crypto'
import { useRef, useState } from 'react'
import { Linking, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Pencil, RotateCw } from 'lucide-react-native'
import { GlassButton } from '@/components/GlassButton'
import { Segmented } from '@/components/Segmented'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { colors } from '@/lib/theme'
import { api, ApiError } from '@/lib/api'
import { mobileMessages } from '@/lib/messages'
import type { ThreadDetail } from '@/lib/types'
import { DESKTOP_RPC_VERSION } from '../../../../../lib/desktop-rpc/version'
import { pullRequestSchema } from '../../../../../lib/issue-metadata'

type Anchor = NonNullable<ThreadDetail['versionAnchors']>[string]
type Version = { id: string; text: string; anchorRunId: string; anchorKey: string; resultRunId: string | null; output: string | null; originalOutput: string | null; pullRequest: string | null; originalPullRequest: string | null }
type Props = { detail: ThreadDetail | undefined; runId: string; itemId: string; text: string; reload: () => Promise<void>; working: boolean; side?: 'start' | 'end' }
const copy = mobileMessages.IssueThreads
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)
const nullableText = (value: unknown) => value === null || typeof value === 'string'
function isVersion(row: unknown): row is Version {
  return isRecord(row) && isId(row.id) && isId(row.anchorRunId) && typeof row.anchorKey === 'string' && typeof row.text === 'string'
    && (row.resultRunId === null || isId(row.resultRunId)) && nullableText(row.output) && nullableText(row.originalOutput)
    && nullableText(row.pullRequest) && nullableText(row.originalPullRequest)
}
async function rpc(action: string, args: unknown[]) {
  const receipt = await api<unknown>('/api/rpc', { method: 'POST', body: { version: DESKTOP_RPC_VERSION, action, args } })
  if (!isRecord(receipt) || receipt.version !== DESKTOP_RPC_VERSION) throw new Error('submissionUnconfirmed')
  if (receipt.ok !== true) throw new Error(isRecord(receipt.error) && typeof receipt.error.code === 'string' ? receipt.error.code : 'submissionUnconfirmed')
  if (isRecord(receipt.result) && typeof receipt.result.error === 'string') throw new Error(receipt.result.error)
  return receipt.result
}

/**
 * Rerun sits once per turn, under the reply that ends it (as Codex and Claude put their action row only under a
 * finished turn): an agent item shows it only when no later agent text comes before the person's next message.
 */
export function endsTurn(items: readonly { kind: string }[], index: number) {
  if (items[index]?.kind !== 'agent') return true
  for (const item of items.slice(index + 1)) {
    if (item.kind === 'person') return true
    if (item.kind === 'agent') return false
  }
  return true
}

export function MobileReplyVersions({ detail, runId, itemId, ...props }: Props) {
  const anchor = detail?.versionAnchors?.[itemId]
  if (!anchor || !detail?.issueId) return null
  return <VersionPicker key={JSON.stringify([detail.issueId, runId, anchor.runId, anchor.key, anchor.operation])}
    {...props} issueId={detail.issueId} runId={runId} anchor={anchor} />
}

function VersionPicker({ issueId, runId, anchor, text, reload, working, side = 'start' }: Pick<Props, 'text' | 'reload' | 'working' | 'runId' | 'side'> & { issueId: string; anchor: Anchor }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [versions, setVersions] = useState<Version[] | null>(null), [selected, setSelected] = useState('original'), [draft, setDraft] = useState(text)
  const submitting = useRef(false), revision = useRef(0), request = useRef<{ id: string; text: string } | null>(null)
  const selectedVersion = versions?.find(row => row.id === selected)
  const original = versions?.[0]
  const output = selectedVersion ? selectedVersion.output : original?.originalOutput ?? (anchor.operation === 'rerun' ? text : null)
  const pull = pullRequestSchema.shape.url.safeParse(selectedVersion ? selectedVersion.pullRequest : original?.originalPullRequest)
  const label = anchor.operation === 'edit' ? copy.versionEdit : copy.versionRerun
  const showError = (failure: unknown) => {
    const code = failure instanceof Error ? failure.message : ''
    const denied = (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) || ['authRequired', 'runNotFound', 'workspaceAccessDenied'].includes(code)
    if (denied) { setVersions(null); setSelected('original') }
    setError((mobileMessages.Errors as Record<string, string>)[code] ?? (denied ? mobileMessages.Coordinator.sendAccessDenied : mobileMessages.Coordinator.sendUncertain))
  }
  async function read() {
    const rows = await rpc('agents.getThreadReplyVersions', [issueId, runId])
    if (!Array.isArray(rows) || !rows.every(isVersion)) throw new Error('submissionUnconfirmed')
    return rows.filter(row => row.anchorRunId === anchor.runId && row.anchorKey === anchor.key)
  }
  function toggle() {
    if (submitting.current) return
    const current = ++revision.current
    setOpen(!open); setError('')
    if (open) return
    setVersions(null); setSelected('original'); setDraft(text)
    void read().then(rows => { if (current === revision.current) setVersions(rows) }).catch(failure => { if (current === revision.current) showError(failure) })
  }
  async function submit() {
    const value = anchor.operation === 'edit' ? draft.trim() : ''
    if (submitting.current || working || !versions || (anchor.operation === 'edit' && !value)) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const operation = request.current?.text === value ? request.current : { id: randomUUID(), text: value }
      request.current = operation
      const change = { anchorRunId: anchor.runId, anchorKey: anchor.key, requestId: operation.id, operation: anchor.operation, ...(anchor.operation === 'edit' ? { text: value } : {}) }
      const receipt = await rpc('agents.createThreadReplyVersion', [{ issueId, runId, change }])
      if (!isRecord(receipt) || !isId(receipt.versionId) || !isId(receipt.runId)) throw new Error('submissionUnconfirmed')
      const rows = await read()
      const saved = rows.find(row => row.id === receipt.versionId)
      if (saved?.resultRunId !== receipt.runId) throw new Error('submissionUnconfirmed')
      setVersions(rows); setSelected(saved.id); setDraft(saved.text)
      await reload()
      request.current = null
    } catch (failure) { showError(failure) }
    finally { submitting.current = false; setBusy(false) }
  }
  // As in the ChatGPT and Claude apps: a small icon under the message, not a full-width button under every reply.
  // It hides while the thread works (nothing can start then); the panel opens below it.
  if (working && !open) return null
  const edit = anchor.operation === 'edit'
  const tint = open ? colors.accent : colors.secondary
  return <View style={[styles.wrap, side === 'end' && styles.end]}>
    <Pressable accessibilityRole="button" accessibilityLabel={open ? `${copy.versionClose} ${label}` : label} accessibilityState={{ expanded: open, disabled: busy }}
      aria-expanded={Platform.OS === 'web' ? open : undefined} disabled={busy} hitSlop={6} onPress={toggle}
      style={({ pressed }) => [styles.icon, pressed && { backgroundColor: colors.pressed }]}>
      <Symbol name={edit ? 'pencil' : 'arrow.clockwise'} size={15} color={tint}
        web={edit ? <Pencil size={15} color={tint} strokeWidth={2} /> : <RotateCw size={15} color={tint} strokeWidth={2} />} />
    </Pressable>
    {open && <View style={styles.panel}>
      <Text style={styles.heading}>{label}</Text>
      <Text style={styles.effects}>{copy.versionEffects}</Text>
      {versions && versions.length > 0 && <Segmented options={[{ value: 'original', label: copy.versionOriginal }, ...versions.map((row, i) => ({ value: row.id, label: copy.versionNumber.replace('{number}', String(i + 2)) }))]}
        value={selected} onChange={id => { setSelected(id); setDraft(versions.find(row => row.id === id)?.text ?? text) }} />}
      {edit && <TextInput multiline editable={!busy} accessibilityLabel={label} value={draft} maxLength={10000} onChangeText={setDraft}
        placeholderTextColor={colors.secondary} style={styles.input} />}
      {versions && (output || selectedVersion) ? <Text selectable style={styles.output}>{output ?? copy.versionPending}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {versions && pull.success ? <GlassButton label={copy.versionPullRequest} onPress={() => void Linking.openURL(pull.data).catch(showError)} /> : null}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" onPress={toggle} disabled={busy} hitSlop={4} style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.6 }]}>
          <Text style={styles.secondaryLabel}>{copy.versionClose}</Text>
        </Pressable>
        <GlassButton label={copy.versionRun} busy={busy} disabled={!versions || busy || working || (edit && !draft.trim())} onPress={() => void submit()} />
      </View>
    </View>}
  </View>
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-start', gap: 6 },
  end: { alignItems: 'flex-end' },
  // 32 pt drawn, 44 pt with the hitSlop (HIG).
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  panel: { alignSelf: 'stretch', gap: 10, padding: 14, borderRadius: 16, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator },
  heading: { fontSize: 15, fontWeight: '600', color: colors.ink },
  effects: { fontSize: 13, lineHeight: 18, color: colors.secondary },
  input: { minHeight: 88, maxHeight: 200, borderRadius: 12, backgroundColor: colors.bubble, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, fontSize: 16, lineHeight: 22, color: colors.text, textAlignVertical: 'top' },
  output: { fontSize: 15, lineHeight: 22, color: colors.text },
  error: { fontSize: 13, color: colors.danger },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  secondaryLabel: { fontSize: 15, color: colors.ink },
})
