'use client'

import { useState } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import type { SettingSource, SettingsView } from '@mikka/protocol/settings'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { updatePreferences } from '@/app/actions/preferences'
import { patchWorkspaceSettings } from '@/app/actions/settings'
import { useLiveKey } from '@/hooks/use-live-key'
import { useThreadTitleSettings } from '@/hooks/settings/use-thread-title-settings'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { settingsRead } from '@/lib/settings-read'
import { settingItemPending, settingItemShown, withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import type { ThreadTitleTriggers } from '@/lib/thread-title'

const TRIGGERS = ['first_run_ended', 'pull_opened', 'either'] as const satisfies readonly ThreadTitleTriggers[]
const ARCHIVE_DAYS = [3, 7, 14, 30, 90] as const
const PARALLEL = [1, 2, 4, 6, 8, 12, 16, 20] as const

export interface ThreadSettingsProps {
  workspaceId?: string
  personal?: boolean
  admin?: boolean
}

/** 线程, frame 1508:73 (Frame 18). Scope tabs, title instructions, idle archive, and workspace subagent concurrency. */
export function ThreadSettings({ workspaceId, personal = false, admin = false }: ThreadSettingsProps) {
  const t = useTranslations('Settings.threadTitles')
  const [scope, setScope] = useState<'mine' | 'workspace'>('mine')
  const shown = scope === 'workspace' && workspaceId ? 'workspace' : 'mine'
  const canEditWorkspace = Boolean(admin || personal)

  return <>
    <ToggleGroup
      aria-label={`${t('scopeMine')} / ${t('scopeWorkspace')}`}
      variant="segment"
      size="sm"
      spacing={0.5}
      value={[shown]}
      onValueChange={values => {
        const next = values[0]
        if (next === 'mine' || (next === 'workspace' && workspaceId)) setScope(next)
      }}
    >
      <ToggleGroupItem value="mine">{t('scopeMine')}</ToggleGroupItem>
      <ToggleGroupItem value="workspace" disabled={!workspaceId}>{t('scopeWorkspace')}</ToggleGroupItem>
    </ToggleGroup>
    <TitleScope key={`${workspaceId ?? ''}:${shown}`} scope={shown} workspaceId={workspaceId} />
    {shown === 'mine'
      ? <PersonalArchiveSection />
      : workspaceId ? <WorkspaceArchiveSection workspaceId={workspaceId} canEdit={canEditWorkspace} /> : null}
    {workspaceId ? <SubagentLimits workspaceId={workspaceId} canEdit={canEditWorkspace} /> : null}
  </>
}

function sourceBadgeLabel(source: SettingSource, pageT: ReturnType<typeof useTranslations<'Settings.threadsPage'>>) {
  if (source === 'personal') return pageT('sourcePersonal')
  if (source === 'workspace') return pageT('sourceWorkspace')
  return pageT('sourceDefault')
}

function SubagentLimits({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const t = useTranslations('Settings.threadTitles')
  const pageT = useTranslations('Settings.threadsPage')
  const common = useTranslations('Common')
  const workspaceKey = settingsKeys.workspaceRegistry(workspaceId)
  const read = useSWR<SettingsView>(
    workspaceKey,
    () => fetchSettingsData<SettingsView>(`/api/settings/workspace/${encodeURIComponent(workspaceId)}`),
    settingsReadOptions,
  )
  useLiveKey('workspace_settings', workspaceId, [unstable_serialize(workspaceKey)], workspaceId)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<number | null>(null)
  if (read.isLoading && !read.data) return <SettingsLoading label={t('subagents')} rows={2} />
  if (read.error && !read.data) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
  const resolved = read.data?.values?.subagentMaxConcurrent
  const raw = resolved?.value
  const source: SettingSource = resolved?.source ?? 'default'
  const current = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 20 ? raw : 6
  const values = PARALLEL.includes(current as typeof PARALLEL[number]) ? PARALLEL : [...PARALLEL, current].sort((a, b) => a - b)
  const currentDisplay = pageT('countWithSource', { count: current, source: sourceBadgeLabel(source, pageT) })
  const options = values.map(count => ({
    value: String(count),
    label: count === current ? currentDisplay : String(count),
  }))
  const depthPending = settingItemPending('threads.subagentDepth')
  const pendingTag = t('pendingBadge')

  function saveMaxConcurrent(next: number) {
    setBusy(true)
    setFailed(null)
    void patchWorkspaceSettings(workspaceId, { values: { subagentMaxConcurrent: next } }).then(async result => {
      if ('error' in result && result.error) { setFailed(next); return }
      await read.mutate(result as SettingsView, { revalidate: false })
    }).catch(() => setFailed(next)).finally(() => setBusy(false))
  }

  return <>
    <SettingsSection title={t('subagents')} description={t('subagentsHint')}>
      <SettingRow title={t('parallel')} description={pageT('parallelTreeHint')}>
        {canEdit
          ? <SettingSelect fluid label={t('parallel')} value={String(current)} disabled={busy} options={options} onValueChange={value => {
            const next = Number(value)
            if (Number.isInteger(next) && next >= 1 && next <= 20 && next !== current) saveMaxConcurrent(next)
          }} />
          : <span>{currentDisplay}</span>}
      </SettingRow>
      {settingItemShown('threads.subagentDepth') && <SettingRow title={depthPending ? withPendingSuffix(t('depth'), pendingTag) : t('depth')} description={t('depthHint')}>
        <span className="text-muted-foreground">{t('runtimeDecided')}</span>
      </SettingRow>}
    </SettingsSection>
    {failed !== null ? <SettingsSaveError message={t('saveError')} retryLabel={common('retry')} onRetry={() => saveMaxConcurrent(failed)} /> : null}
  </>
}

function TitleScope({ scope, workspaceId }: { scope: 'mine' | 'workspace'; workspaceId?: string | null }) {
  const t = useTranslations('Settings.threadTitles')
  const pageT = useTranslations('Settings.threadsPage')
  const common = useTranslations('Common')
  const titles = useThreadTitleSettings(scope, workspaceId ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!titles.loaded && !titles.loadFailed) return <SettingsLoading label={t('title')} rows={2} />
  if (titles.loadFailed) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={titles.reload} />
  const triggerValue = titles.triggers ?? 'workspace'
  const triggerLabels: Record<ThreadTitleTriggers, string> = {
    first_run_ended: t('firstRunEnded'),
    pull_opened: t('pullOpened'),
    either: t('either'),
  }
  const activeSource = scope === 'mine' ? pageT('sourcePersonal') : pageT('sourceWorkspace')
  const options = [
    ...scope === 'mine' ? [{ value: 'workspace', label: t('inheritNever') }] : [],
    ...TRIGGERS.map(trigger => ({
      value: trigger,
      label: triggerValue === trigger
        ? pageT('valueWithSource', { value: triggerLabels[trigger], source: activeSource })
        : triggerLabels[trigger],
    })),
  ]
  const currentOptionLabel = options.find(item => item.value === triggerValue)?.label ?? t('inheritNever')
  const hasInstructions = Boolean(titles.instructions.trim())

  return <SettingsSection title={t('title')}>
    <SettingRow title={t('command')} description={hasInstructions ? titles.instructions : t('none')}>
      {titles.canEdit
        ? <Button type="button" size="sm" variant="outline" disabled={titles.busy} onClick={() => { setDraft(titles.instructions); setEditing(true) }}>
          {hasInstructions ? t('edit') : pageT('add')}
        </Button>
        : <span className="text-muted-foreground">{hasInstructions ? pageT('configured') : t('none')}</span>}
    </SettingRow>
    <SettingRow title={t('regenerate')} description={t('triggersHint')}>
      {titles.canEdit
        ? <SettingSelect fluid label={t('regenerate')} value={triggerValue} disabled={titles.busy} options={options} onValueChange={value => {
          if (!value || value === triggerValue || (!TRIGGERS.includes(value as ThreadTitleTriggers) && value !== 'workspace')) return
          titles.setTriggers(value === 'workspace' ? null : value as ThreadTitleTriggers)
        }} />
        : <span>{currentOptionLabel}</span>}
    </SettingRow>
    {titles.message ? <p role={titles.message.kind === 'saved' ? 'status' : 'alert'} className="px-4 py-3 text-sm text-muted-foreground">{titles.message.text}</p> : null}
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('command')}</DialogTitle></DialogHeader>
        <Textarea aria-label={t('command')} value={draft} maxLength={1000} rows={5} placeholder={t('placeholder')} onChange={event => setDraft(event.target.value)} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>{common('cancel')}</Button>
          <Button type="button" onClick={() => { titles.commit(draft); setEditing(false) }}>{common('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsSection>
}

function PersonalArchiveSection() {
  const t = useTranslations('Settings.threadTitles')
  const pageT = useTranslations('Settings.threadsPage')
  const common = useTranslations('Common')
  const read = useSWR(settingsKeys.preferences(), () => settingsRead<{ archiveIdleAfterDays?: number; error?: string }>('preferences'))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const days = read.data && !read.data.error ? read.data.archiveIdleAfterDays ?? 0 : null
  if (read.isLoading && days === null) return <SettingsLoading label={t('archive')} rows={1} />
  if (read.error || read.data?.error || days === null) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
  const options = [{ value: '0', label: t('archiveOff') }, ...ARCHIVE_DAYS.map(value => ({ value: String(value), label: t('archiveDays', { days: value }) }))]
  return <>
    <SettingsSection title={t('archive')}>
      <SettingRow title={t('archiveIdle')} description={t('archiveHint')}>
        <SettingSelect fluid label={t('archiveIdle')} value={String(days)} disabled={busy} options={options} onValueChange={value => {
          const next = Number(value)
          if (!Number.isInteger(next) || next === days) return
          setBusy(true); setFailed(false)
          void updatePreferences({ archiveIdleAfterDays: next }).then(async result => {
            if ('error' in result && result.error) { setFailed(true); return }
            await read.mutate()
          }).catch(() => setFailed(true)).finally(() => setBusy(false))
        }} />
      </SettingRow>
    </SettingsSection>
    {failed ? <SettingsSaveError message={pageT('archiveSaveError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} /> : null}
  </>
}

function WorkspaceArchiveSection({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const t = useTranslations('Settings.threadTitles')
  const pageT = useTranslations('Settings.threadsPage')
  const common = useTranslations('Common')
  const workspaceKey = settingsKeys.workspaceRegistry(workspaceId)
  const read = useSWR<SettingsView>(
    workspaceKey,
    () => fetchSettingsData<SettingsView>(`/api/settings/workspace/${encodeURIComponent(workspaceId)}`),
    settingsReadOptions,
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<number | null>(null)
  if (read.isLoading && !read.data) return <SettingsLoading label={t('archive')} rows={1} />
  if (read.error && !read.data) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
  const resolved = read.data?.values?.archiveIdleAfterDays
  const raw = resolved?.value
  const source: SettingSource = resolved?.source ?? 'default'
  const current = typeof raw === 'number' && (raw === 0 || ARCHIVE_DAYS.includes(raw as typeof ARCHIVE_DAYS[number])) ? raw : 30
  const baseLabel = (days: number) => days === 0 ? t('archiveOff') : t('archiveDays', { days })
  const currentDisplay = pageT('valueWithSource', { value: baseLabel(current), source: sourceBadgeLabel(source, pageT) })
  const options = [0, ...ARCHIVE_DAYS].map(days => ({
    value: String(days),
    label: days === current ? currentDisplay : baseLabel(days),
  }))

  function saveWorkspaceArchive(next: number) {
    setBusy(true)
    setFailed(null)
    void patchWorkspaceSettings(workspaceId, { values: { archiveIdleAfterDays: next } }).then(async result => {
      if ('error' in result && result.error) { setFailed(next); return }
      await read.mutate(result as SettingsView, { revalidate: false })
    }).catch(() => setFailed(next)).finally(() => setBusy(false))
  }

  return <>
    <SettingsSection title={t('archive')}>
      <SettingRow title={t('archiveIdle')} description={t('archiveHint')}>
        {canEdit
          ? <SettingSelect fluid label={t('archiveIdle')} value={String(current)} disabled={busy} options={options} onValueChange={value => {
            const next = Number(value)
            if (Number.isInteger(next) && next !== current) saveWorkspaceArchive(next)
          }} />
          : <span>{currentDisplay}</span>}
      </SettingRow>
    </SettingsSection>
    {failed !== null ? <SettingsSaveError message={pageT('archiveSaveError')} retryLabel={common('retry')} onRetry={() => saveWorkspaceArchive(failed)} /> : null}
  </>
}
