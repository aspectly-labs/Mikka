'use client'

import { useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import type { SettingScope, SettingSource, SettingValue, SettingsView } from '@mikka/protocol/settings'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { patchWorkspaceSettings } from '@/app/actions/settings'
import { useLiveKey } from '@/hooks/use-live-key'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
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

function personalThreadsKey(workspaceId: string) {
  return ['settings:personal:threads', workspaceId] as const
}

async function patchScopeSettings(
  scope: SettingScope,
  workspaceId: string,
  values: Record<string, SettingValue | null>,
): Promise<SettingsView> {
  const url = scope === 'personal'
    ? `/api/settings/personal?workspaceId=${encodeURIComponent(workspaceId)}`
    : `/api/settings/workspace/${encodeURIComponent(workspaceId)}`
  const response = await fetch(withBasePath(url), {
    method: 'PATCH',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  if (!response.ok) throw new Error('Settings patch failed')
  return response.json() as Promise<SettingsView>
}

async function resetScopeGroup(scope: SettingScope, workspaceId: string, group: string): Promise<SettingsView> {
  const url = scope === 'personal'
    ? `/api/settings/personal/reset?workspaceId=${encodeURIComponent(workspaceId)}`
    : `/api/settings/workspace/${encodeURIComponent(workspaceId)}/reset`
  const response = await fetch(withBasePath(url), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group }),
  })
  if (!response.ok) throw new Error('Settings reset failed')
  return response.json() as Promise<SettingsView>
}

function sourceBadgeLabel(source: SettingSource, pageT: ReturnType<typeof useTranslations<'Settings.threadsPage'>>) {
  if (source === 'personal') return pageT('sourcePersonal')
  if (source === 'workspace') return pageT('sourceWorkspace')
  return pageT('sourceDefault')
}

/** 线程, frame 1508:73 (Frame 18). Scope tabs, title instructions, idle archive, and workspace subagent concurrency. */
export function ThreadSettings({ workspaceId, personal = false, admin = false }: ThreadSettingsProps) {
  const t = useTranslations('Settings.threadTitles')
  const [scope, setScope] = useState<'mine' | 'workspace'>('mine')

  if (!workspaceId) {
    return <SettingsLoading label={t('title')} rows={3} />
  }

  const activeScope: SettingScope = scope === 'workspace' ? 'workspace' : 'personal'
  const canEditWorkspace = Boolean(admin || personal)

  return (
    <>
      <ThreadScopeBody
        key={`${workspaceId}:${activeScope}`}
        workspaceId={workspaceId}
        scope={activeScope}
        onScopeChange={next => setScope(next === 'workspace' ? 'workspace' : 'mine')}
        canEditWorkspace={canEditWorkspace}
      />
      <SubagentLimits workspaceId={workspaceId} canEdit={canEditWorkspace} />
    </>
  )
}

function ThreadScopeBody({
  workspaceId,
  scope,
  onScopeChange,
  canEditWorkspace,
}: {
  workspaceId: string
  scope: SettingScope
  onScopeChange: (next: SettingScope) => void
  canEditWorkspace: boolean
}) {
  const t = useTranslations('Settings.threadTitles')
  const pageT = useTranslations('Settings.threadsPage')
  const common = useTranslations('Common')
  const { mutate: mutateGlobal } = useSWRConfig()

  const pKey = personalThreadsKey(workspaceId)
  const wKey = settingsKeys.workspaceRegistry(workspaceId)
  const activeKey = scope === 'personal' ? pKey : wKey
  const activeUrl = scope === 'personal'
    ? `/api/settings/personal?workspaceId=${encodeURIComponent(workspaceId)}`
    : `/api/settings/workspace/${encodeURIComponent(workspaceId)}`

  const read = useSWR<SettingsView>(activeKey, () => fetchSettingsData<SettingsView>(activeUrl), settingsReadOptions)
  useLiveKey('workspace_settings', workspaceId, [unstable_serialize(pKey), unstable_serialize(wKey)], workspaceId)

  const [editingInstructions, setEditingInstructions] = useState(false)
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [busyField, setBusyField] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [failedPatch, setFailedPatch] = useState<{ field: string; values: Record<string, SettingValue | null>; message: string } | null>(null)
  const [resetFailed, setResetFailed] = useState(false)

  const canEdit = scope === 'personal' ? true : canEditWorkspace

  if (read.isLoading && !read.data) {
    return (
      <>
        <ThreadScopeHeader scope={scope} onScopeChange={onScopeChange} canReset={false} resetting={false} onReset={async () => {}} />
        <SettingsLoading label={t('title')} rows={2} />
        <SettingsLoading label={t('archive')} rows={1} />
      </>
    )
  }

  if (read.error && !read.data) {
    return (
      <>
        <ThreadScopeHeader scope={scope} onScopeChange={onScopeChange} canReset={false} resetting={false} onReset={async () => {}} />
        <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
      </>
    )
  }

  const values = read.data?.values ?? {}
  const instructionsEntry = values.threadTitleInstructions
  const triggersEntry = values.threadTitleTriggers
  const archiveEntry = values.archiveIdleAfterDays
  const subagentEntry = values.subagentMaxConcurrent

  const currentInstructions = typeof instructionsEntry?.value === 'string' ? instructionsEntry.value : ''
  const instructionsSource: SettingSource = instructionsEntry?.source ?? 'default'

  const rawTrigger = triggersEntry?.value
  const currentTrigger: ThreadTitleTriggers =
    typeof rawTrigger === 'string' && TRIGGERS.includes(rawTrigger as ThreadTitleTriggers)
      ? (rawTrigger as ThreadTitleTriggers)
      : 'first_run_ended'
  const triggerSource: SettingSource = triggersEntry?.source ?? 'default'

  const rawArchive = archiveEntry?.value
  const currentArchive =
    typeof rawArchive === 'number' && (rawArchive === 0 || ARCHIVE_DAYS.includes(rawArchive as typeof ARCHIVE_DAYS[number]))
      ? rawArchive
      : 30
  const archiveSource: SettingSource = archiveEntry?.source ?? 'default'

  const scopeEntries = scope === 'personal'
    ? [instructionsEntry, triggersEntry, archiveEntry]
    : [instructionsEntry, triggersEntry, archiveEntry, subagentEntry]
  const hasScopeOverrides = scopeEntries.some(entry => entry?.source === scope)

  async function applyPatch(field: string, patchValues: Record<string, SettingValue | null>, errorMessage: string): Promise<boolean> {
    setBusyField(field)
    setFailedPatch(null)
    setResetFailed(false)
    try {
      const updated = await patchScopeSettings(scope, workspaceId, patchValues)
      await read.mutate(updated, { revalidate: false })
      if (scope === 'workspace') void mutateGlobal(pKey)
      return true
    } catch {
      setFailedPatch({ field, values: patchValues, message: errorMessage })
      return false
    } finally {
      setBusyField(null)
    }
  }

  async function handleReset() {
    setResetting(true)
    setResetFailed(false)
    setFailedPatch(null)
    try {
      const updated = await resetScopeGroup(scope, workspaceId, 'threads')
      await read.mutate(updated, { revalidate: false })
      if (scope === 'workspace') void mutateGlobal(pKey)
    } catch {
      setResetFailed(true)
    } finally {
      setResetting(false)
    }
  }

  const triggerLabels: Record<ThreadTitleTriggers, string> = {
    first_run_ended: t('firstRunEnded'),
    pull_opened: t('pullOpened'),
    either: t('either'),
  }
  const triggerOptions = [
    ...(scope === 'personal' && triggerSource === 'personal'
      ? [{ value: '__inherit__', label: t('workspaceDefault') }]
      : []),
    ...TRIGGERS.map(trigger => ({
      value: trigger,
      label: trigger === currentTrigger
        ? pageT('valueWithSource', { value: triggerLabels[trigger], source: sourceBadgeLabel(triggerSource, pageT) })
        : triggerLabels[trigger],
    })),
  ]
  const currentTriggerDisplay = pageT('valueWithSource', {
    value: triggerLabels[currentTrigger],
    source: sourceBadgeLabel(triggerSource, pageT),
  })

  const baseArchiveLabel = (days: number) => (days === 0 ? t('archiveOff') : t('archiveDays', { days }))
  const currentArchiveDisplay = pageT('valueWithSource', {
    value: baseArchiveLabel(currentArchive),
    source: sourceBadgeLabel(archiveSource, pageT),
  })
  const archiveOptions = [0, ...ARCHIVE_DAYS].map(days => ({
    value: String(days),
    label: days === currentArchive ? currentArchiveDisplay : baseArchiveLabel(days),
  }))

  const hasInstructions = Boolean(currentInstructions.trim())
  const instructionsTitle = pageT('valueWithSource', {
    value: t('command'),
    source: sourceBadgeLabel(instructionsSource, pageT),
  })

  return (
    <>
      <ThreadScopeHeader
        scope={scope}
        onScopeChange={onScopeChange}
        canReset={canEdit && hasScopeOverrides}
        resetting={resetting}
        onReset={handleReset}
      />

      <SettingsSection title={t('title')}>
        <SettingRow title={instructionsTitle} description={hasInstructions ? currentInstructions : t('none')}>
          {canEdit ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busyField === 'threadTitleInstructions' || resetting}
              onClick={() => {
                setInstructionsDraft(currentInstructions)
                setEditingInstructions(true)
              }}
            >
              {hasInstructions ? t('edit') : pageT('add')}
            </Button>
          ) : (
            <span className="text-muted-foreground">{hasInstructions ? pageT('configured') : t('none')}</span>
          )}
        </SettingRow>

        <SettingRow title={t('regenerate')} description={t('triggersHint')}>
          {canEdit ? (
            <SettingSelect
              fluid
              label={t('regenerate')}
              value={currentTrigger}
              disabled={busyField === 'threadTitleTriggers' || resetting}
              options={triggerOptions}
              onValueChange={value => {
                if (!value) return
                if (value === '__inherit__' && scope === 'personal') {
                  void applyPatch('threadTitleTriggers', { threadTitleTriggers: null }, t('triggersError'))
                  return
                }
                if (TRIGGERS.includes(value as ThreadTitleTriggers) && (value !== currentTrigger || triggerSource !== scope)) {
                  void applyPatch('threadTitleTriggers', { threadTitleTriggers: value as ThreadTitleTriggers }, t('triggersError'))
                }
              }}
            />
          ) : (
            <span>{currentTriggerDisplay}</span>
          )}
        </SettingRow>

        <Dialog open={editingInstructions} onOpenChange={open => { if (!open && busyField !== 'threadTitleInstructions') setEditingInstructions(false) }}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{t('command')}</DialogTitle>
            </DialogHeader>
            <Textarea
              aria-label={t('command')}
              value={instructionsDraft}
              maxLength={1000}
              rows={5}
              placeholder={t('placeholder')}
              onChange={event => setInstructionsDraft(event.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setEditingInstructions(false)}>
                {common('cancel')}
              </Button>
              <Button
                type="button"
                busy={busyField === 'threadTitleInstructions'}
                onClick={() => {
                  const trimmed = instructionsDraft.trim()
                  if (trimmed === currentInstructions && instructionsSource === scope) {
                    setEditingInstructions(false)
                    return
                  }
                  void applyPatch('threadTitleInstructions', { threadTitleInstructions: trimmed }, t('saveError')).then(ok => {
                    if (ok) setEditingInstructions(false)
                  })
                }}
              >
                {common('save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsSection>

      <SettingsSection title={t('archive')}>
        <SettingRow title={t('archiveIdle')} description={t('archiveHint')}>
          {canEdit ? (
            <SettingSelect
              fluid
              label={t('archiveIdle')}
              value={String(currentArchive)}
              disabled={busyField === 'archiveIdleAfterDays' || resetting}
              options={archiveOptions}
              onValueChange={value => {
                const next = Number(value)
                if (Number.isInteger(next) && (next !== currentArchive || archiveSource !== scope)) {
                  void applyPatch('archiveIdleAfterDays', { archiveIdleAfterDays: next }, pageT('archiveSaveError'))
                }
              }}
            />
          ) : (
            <span>{currentArchiveDisplay}</span>
          )}
        </SettingRow>
      </SettingsSection>

      {failedPatch ? (
        <SettingsSaveError
          message={failedPatch.message}
          retryLabel={common('retry')}
          onRetry={() => { void applyPatch(failedPatch.field, failedPatch.values, failedPatch.message) }}
        />
      ) : null}
      {resetFailed ? (
        <SettingsSaveError
          message={pageT('resetError')}
          retryLabel={common('retry')}
          onRetry={() => { void handleReset() }}
        />
      ) : null}
    </>
  )
}

function ThreadScopeHeader({
  scope,
  onScopeChange,
  canReset,
  resetting,
  onReset,
}: {
  scope: SettingScope
  onScopeChange: (next: SettingScope) => void
  canReset: boolean
  resetting: boolean
  onReset: () => Promise<void>
}) {
  const t = useTranslations('Settings.threadTitles')
  const pageT = useTranslations('Settings.threadsPage')
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ToggleGroup
        aria-label={`${t('scopeMine')} / ${t('scopeWorkspace')}`}
        variant="segment"
        size="sm"
        spacing={0.5}
        value={[scope === 'workspace' ? 'workspace' : 'mine']}
        onValueChange={values => {
          const next = values[0]
          if (next === 'mine') onScopeChange('personal')
          if (next === 'workspace') onScopeChange('workspace')
        }}
      >
        <ToggleGroupItem value="mine">{t('scopeMine')}</ToggleGroupItem>
        <ToggleGroupItem value="workspace">{t('scopeWorkspace')}</ToggleGroupItem>
      </ToggleGroup>
      {canReset ? (
        <Button type="button" variant="ghost" size="sm" busy={resetting} onClick={onReset}>
          {scope === 'personal' ? pageT('resetInherit') : pageT('resetDefaults')}
        </Button>
      ) : null}
    </div>
  )
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

  return (
    <>
      <SettingsSection title={t('subagents')} description={t('subagentsHint')}>
        <SettingRow title={t('parallel')} description={pageT('parallelTreeHint')}>
          {canEdit ? (
            <SettingSelect
              fluid
              label={t('parallel')}
              value={String(current)}
              disabled={busy}
              options={options}
              onValueChange={value => {
                const next = Number(value)
                if (Number.isInteger(next) && next >= 1 && next <= 20 && next !== current) saveMaxConcurrent(next)
              }}
            />
          ) : (
            <span>{currentDisplay}</span>
          )}
        </SettingRow>
        {settingItemShown('threads.subagentDepth') && (
          <SettingRow title={depthPending ? withPendingSuffix(t('depth'), pendingTag) : t('depth')} description={t('depthHint')}>
            <span className="text-muted-foreground">{t('runtimeDecided')}</span>
          </SettingRow>
        )}
      </SettingsSection>
      {failed !== null ? (
        <SettingsSaveError message={t('saveError')} retryLabel={common('retry')} onRetry={() => saveMaxConcurrent(failed)} />
      ) : null}
    </>
  )
}
