'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { SettingsView } from '@mikka/protocol/settings'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { updatePreferences } from '@/app/actions/preferences'
import { patchWorkspaceSettings } from '@/app/actions/settings'
import { useThreadTitleSettings } from '@/hooks/settings/use-thread-title-settings'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { settingsRead } from '@/lib/settings-read'
import { settingItemPending, settingItemShown, withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'
import type { ThreadTitleTriggers } from '@/lib/thread-title'

const TRIGGERS = ['first_run_ended', 'pull_opened', 'either'] as const satisfies readonly ThreadTitleTriggers[]
const ARCHIVE_DAYS = [3, 7, 14, 30, 90] as const
const PARALLEL = [1, 2, 4, 6, 8, 12, 16, 20] as const

/** 线程, frame 1508:73. Title instructions, idle archive, and workspace subagent concurrency save to registered settings. */
export function ThreadSettings({ workspaceId, personal, admin = false }: { workspaceId?: string; personal: boolean; admin?: boolean }) {
  const t = useTranslations('Settings.threadTitles')
  const [scope, setScope] = useState<'mine' | 'workspace'>('mine')
  const shown = scope === 'workspace' && workspaceId && !personal ? 'workspace' : 'mine'
  return <>
    {workspaceId && !personal ? <div className="flex gap-1" role="group" aria-label={`${t('scopeMine')} / ${t('scopeWorkspace')}`}>
      <Button type="button" size="sm" variant={shown === 'mine' ? 'secondary' : 'ghost'} aria-pressed={shown === 'mine'} onClick={() => setScope('mine')}>{t('scopeMine')}</Button>
      <Button type="button" size="sm" variant={shown === 'workspace' ? 'secondary' : 'ghost'} aria-pressed={shown === 'workspace'} onClick={() => setScope('workspace')}>{t('scopeWorkspace')}</Button>
    </div> : null}
    <TitleScope key={`${workspaceId ?? ''}:${shown}`} scope={shown} workspaceId={workspaceId} />
    {shown === 'mine' ? <ArchiveSection /> : null}
    {workspaceId ? <SubagentLimits workspaceId={workspaceId} canEdit={admin || personal} /> : null}
  </>
}

function SubagentLimits({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const t = useTranslations('Settings.threadTitles')
  const common = useTranslations('Common')
  const read = useSWR<SettingsView>(
    settingsKeys.workspaceRegistry(workspaceId),
    () => fetchSettingsData<SettingsView>(`/api/settings/workspace/${encodeURIComponent(workspaceId)}`),
    settingsReadOptions,
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<number | null>(null)
  if (read.isLoading && !read.data) return <SettingsLoading label={t('subagents')} rows={2} />
  if (read.error && !read.data) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
  const raw = read.data?.values?.subagentMaxConcurrent?.value
  const current = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 20 ? raw : 6
  const values = PARALLEL.includes(current as typeof PARALLEL[number]) ? PARALLEL : [...PARALLEL, current].sort((a, b) => a - b)
  const options = values.map(count => ({ value: String(count), label: t('countWorkspace', { count }) }))
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
    <SettingsSection title={t('subagents')}>
      <SettingRow title={t('parallel')} description={t('parallelHint')}>
        {canEdit
          ? <SettingSelect label={t('parallel')} value={String(current)} disabled={busy} options={options} onValueChange={value => {
            const next = Number(value)
            if (Number.isInteger(next) && next >= 1 && next <= 20 && next !== current) saveMaxConcurrent(next)
          }} />
          : <span>{t('countWorkspace', { count: current })}</span>}
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
  const common = useTranslations('Common')
  const titles = useThreadTitleSettings(scope, workspaceId ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!titles.loaded && !titles.loadFailed) return <SettingsLoading label={t('title')} rows={2} />
  if (titles.loadFailed) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={titles.reload} />
  const triggerValue = titles.triggers ?? 'workspace'
  const options = [
    ...scope === 'mine' ? [{ value: 'workspace', label: t('inheritNever') }] : [],
    { value: 'first_run_ended', label: t('firstRunEnded') },
    { value: 'pull_opened', label: t('pullOpened') },
    { value: 'either', label: t('either') },
  ]
  return <SettingsSection title={t('title')}>
    <SettingRow title={t('command')} description={titles.instructions.trim() ? titles.instructions : t('none')}>
      <Button type="button" size="sm" variant="outline" disabled={!titles.canEdit || titles.busy} onClick={() => { setDraft(titles.instructions); setEditing(true) }}>{t('edit')}</Button>
    </SettingRow>
    <SettingRow title={t('regenerate')} description={t('triggersHint')}>
      <SettingSelect label={t('regenerate')} value={triggerValue} disabled={!titles.canEdit || titles.busy} options={options} onValueChange={value => {
        if (!value || value === triggerValue || !TRIGGERS.includes(value as ThreadTitleTriggers) && value !== 'workspace') return
        titles.setTriggers(value === 'workspace' ? null : value as ThreadTitleTriggers)
      }} />
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

function ArchiveSection() {
  const t = useTranslations('Settings.threadTitles')
  const common = useTranslations('Common')
  const read = useSWR(settingsKeys.preferences(), () => settingsRead<{ archiveIdleAfterDays?: number; error?: string }>('preferences'))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const days = read.data && !read.data.error ? read.data.archiveIdleAfterDays ?? 0 : null
  if (read.isLoading && days === null) return <SettingsLoading label={t('archive')} rows={1} />
  if (read.error || read.data?.error || days === null) return <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
  const options = [{ value: '0', label: t('archiveOff') }, ...ARCHIVE_DAYS.map(value => ({ value: String(value), label: t('archiveDays', { days: value }) }))]
  return <SettingsSection title={t('archive')}>
    <SettingRow title={t('archiveIdle')} description={t('archiveHint')}>
      <SettingSelect label={t('archiveIdle')} value={String(days)} disabled={busy} options={options} onValueChange={value => {
        const next = Number(value)
        if (!Number.isInteger(next) || next === days) return
        setBusy(true); setFailed(false)
        void updatePreferences({ archiveIdleAfterDays: next }).then(async result => {
          if ('error' in result && result.error) { setFailed(true); return }
          await read.mutate()
        }).catch(() => setFailed(true)).finally(() => setBusy(false))
      }} />
    </SettingRow>
    {failed ? <SettingsSaveError message={t('saveError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} /> : null}
  </SettingsSection>
}
