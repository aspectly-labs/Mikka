'use client'

import { useEffect, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { ChevronLeft, Laptop, Pencil, Plus, Server, Trash2 } from '@/components/icons'
import type { DeviceView } from '@/app/actions/agents'
import { AgentMarks, installedAgents } from '@/components/devices/agent-marks'
import { useDeviceActions } from '@/components/devices/use-device-actions'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { withBasePath } from '@/lib/base-path'
import { canRenameDevice, DEVICE_DESCRIPTION_MAX, DEVICE_NAME_MAX } from '@/lib/device-name'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import type { DevicePolicyView, DeviceRepositoryItem, DeviceRepositoryListView } from '@/lib/settings/device-policy-contract'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'

interface DeviceTokenRow {
  id: string
  name: string | null
  createdAt: string
  revokedAt: string | null
  boundDeviceId: string | null
  deviceIds: string[]
}

interface DeviceTokensResponse {
  tokens: DeviceTokenRow[]
}

export interface DeviceDetailViewProps {
  device: DeviceView
  workspaceId?: string
  workspaceName?: string
  onBack: () => void
  onChanged: () => void
  onReconnect: (device: DeviceView) => void
}

const detailReadOptions = { ...settingsReadOptions, revalidateOnFocus: false } as const

function formatPlatformTitle(platform: string | null): string | null {
  if (!platform) return null
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  if (platform === 'win32') return 'Windows'
  return platform
}

function formatPlatformFamily(platform: string | null): string | null {
  if (!platform) return null
  if (platform === 'darwin') return 'Mac'
  if (platform === 'linux') return 'Linux'
  if (platform === 'win32') return 'Windows'
  return platform
}

async function requestJson<T>(url: string, init: RequestInit): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  try {
    const response = await fetch(withBasePath(url), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })
    const body = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) return { ok: false, code: body?.error ?? 'deviceSaveFailed' }
    return { ok: true, data: body as T }
  } catch {
    return { ok: false, code: 'deviceSaveFailed' }
  }
}

export function DeviceDetailView({ device, workspaceId, workspaceName, onBack, onChanged, onReconnect }: DeviceDetailViewProps) {
  const t = useTranslations('Settings.devicesDetail')
  const tDevices = useTranslations('Devices')
  const common = useTranslations('Common')
  const locale = useLocale()
  const translateError = useActionError()
  const { busy, rename, setDescription, remove, command } = useDeviceActions(device, onChanged)

  const policyUrl = `/api/devices/${encodeURIComponent(device.id)}/policy${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`
  const policyRead = useSWR<DevicePolicyView>(
    ['device-policy', device.id, workspaceId ?? null],
    () => fetchSettingsData<DevicePolicyView>(policyUrl),
    detailReadOptions,
  )
  const reposUrl = `/api/devices/${encodeURIComponent(device.id)}/repositories`
  const reposRead = useSWR<DeviceRepositoryListView>(
    ['device-repositories', device.id],
    () => fetchSettingsData<DeviceRepositoryListView>(reposUrl),
    detailReadOptions,
  )
  const tokensRead = useSWR<DeviceTokensResponse>(
    ['device-tokens-identity', device.id],
    () => fetchSettingsData<DeviceTokensResponse>('/api/device-tokens'),
    detailReadOptions,
  )

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(device.name)
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState(device.description ?? '')
  const [removing, setRemoving] = useState(false)

  const [policyBusy, setPolicyBusy] = useState(false)
  const [failedPolicyPatch, setFailedPolicyPatch] = useState<{ schedulingEnabled?: boolean; computerUseEnabled?: boolean } | null>(null)

  const [repoDialog, setRepoDialog] = useState<{ mode: 'add' } | { mode: 'edit'; item: DeviceRepositoryItem } | null>(null)
  const [removingRepo, setRemovingRepo] = useState<DeviceRepositoryItem | null>(null)
  const [repoBusy, setRepoBusy] = useState(false)
  const [repoDeleteError, setRepoDeleteError] = useState('')

  useEffect(() => {
    setNameDraft(device.name)
    setDescriptionDraft(device.description ?? '')
  }, [device.id, device.name, device.description])

  const agents = installedAgents(device.harnesses)
  const policy = policyRead.data
  const repositories = reposRead.data?.repositories

  const matchedToken = tokensRead.data?.tokens.find(
    token => !token.revokedAt && (token.boundDeviceId === device.id || token.deviceIds.includes(device.id)),
  )

  const platformSummary = [
    formatPlatformFamily(device.platform),
    device.platform && device.arch ? `${device.platform}/${device.arch}` : device.platform ?? device.arch,
    device.hostname,
  ].filter(Boolean).join(' · ')

  async function savePolicy(patch: { schedulingEnabled?: boolean; computerUseEnabled?: boolean }) {
    if (policyBusy) return
    setPolicyBusy(true)
    setFailedPolicyPatch(null)
    const previous = policy
    if (previous) {
      await policyRead.mutate({
        ...previous,
        ...(patch.schedulingEnabled !== undefined ? {
          schedulingEnabled: patch.schedulingEnabled,
          scheduling: { ...previous.scheduling, enabled: patch.schedulingEnabled },
        } : {}),
        ...(patch.computerUseEnabled !== undefined ? {
          computerUseEnabled: patch.computerUseEnabled,
          computerUse: {
            ...previous.computerUse,
            enabled: patch.computerUseEnabled,
            mode: patch.computerUseEnabled ? 'allow' : 'deny',
          },
        } : {}),
      }, { revalidate: false })
    }
    const result = await requestJson<DevicePolicyView>(policyUrl, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, ...(workspaceId ? { workspaceId } : {}) }),
    })
    setPolicyBusy(false)
    if (!result.ok) {
      if (previous) await policyRead.mutate(previous, { revalidate: false })
      setFailedPolicyPatch(patch)
      return
    }
    await policyRead.mutate(result.data, { revalidate: false })
    onChanged()
  }

  async function confirmDeleteRepository() {
    if (!removingRepo || repoBusy) return
    setRepoBusy(true)
    setRepoDeleteError('')
    const result = await requestJson<{ deleted: true }>(reposUrl, {
      method: 'DELETE',
      body: JSON.stringify({ id: removingRepo.id, repoKey: removingRepo.repoKey }),
    })
    setRepoBusy(false)
    if (!result.ok) {
      setRepoDeleteError(translateError(result.code))
      return
    }
    setRemovingRepo(null)
    await reposRead.mutate()
    onChanged()
  }

  const DeviceKindGlyph = device.deviceType === 'server' ? Server : Laptop
  const canSaveDescription = !busy
    && descriptionDraft.trim() !== (device.description ?? '')
    && descriptionDraft.trim().length <= DEVICE_DESCRIPTION_MAX

  return (
    <div data-settings-subview="" className="flex flex-col gap-6">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden="true" />
        {t('backToDevices')}
      </Button>

      <header className="flex flex-col gap-1.5 pl-1">
        <div className="flex items-center gap-1.5">
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground">{device.name}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={tDevices('actions.rename')}
            onClick={() => { setNameDraft(device.name); setRenaming(true) }}
          >
            <Pencil aria-hidden="true" />
          </Button>
        </div>

        {editingDescription ? (
          <form
            className="flex flex-wrap items-center gap-2 pt-0.5"
            onSubmit={async event => {
              event.preventDefault()
              if (canSaveDescription && await setDescription(descriptionDraft)) setEditingDescription(false)
            }}
          >
            <FieldGroup className="min-w-0 flex-1 max-w-sm">
              <Field>
                <FieldLabel htmlFor={`detail-desc-${device.id}`} className="sr-only">{tDevices('descriptionLabel')}</FieldLabel>
                <Input
                  id={`detail-desc-${device.id}`}
                  className="h-(--control-sm)"
                  autoFocus
                  maxLength={DEVICE_DESCRIPTION_MAX}
                  value={descriptionDraft}
                  placeholder={t('descriptionPlaceholder')}
                  onChange={event => setDescriptionDraft(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <Button type="button" variant="secondary" size="sm" onClick={() => { setDescriptionDraft(device.description ?? ''); setEditingDescription(false) }}>
              {common('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSaveDescription}>
              {common('save')}
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 break-words">{device.description || t('descriptionPlaceholder')}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={tDevices('actions.editDescription')}
              onClick={() => { setDescriptionDraft(device.description ?? ''); setEditingDescription(true) }}
            >
              <Pencil aria-hidden="true" />
            </Button>
          </div>
        )}

        {platformSummary ? <p className="text-xs text-muted-foreground">{platformSummary}</p> : null}
      </header>

      <SettingsSection id="device-status-heading" title={t('statusHeading')}>
        <SettingRow title={t('onlineStatusLabel')}>
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', device.online ? 'bg-success' : 'bg-muted-foreground/50')} />
            <span className={cn(!device.online && 'text-muted-foreground')}>
              {device.online ? t('connectedStatus') : tDevices('offline')}
            </span>
          </span>
        </SettingRow>
        <SettingRow title={t('lastConnectedLabel')}>
          <span className="text-muted-foreground">
            {device.lastSeenAt
              ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(device.lastSeenAt))
              : tDevices('neverOnline')}
          </span>
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="device-hardware-heading" title={t('hardwareHeading')} description={t('hardwareDescription')}>
        <SettingRow title={t('hardwareTypeLabel')}>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <DeviceKindGlyph aria-hidden="true" className="size-4 shrink-0" />
            <span>{device.deviceType === 'server' ? t('typeServer') : t('typeLaptop')}</span>
          </span>
        </SettingRow>
        <SettingRow title={t('hardwareHostLabel')}>
          <span className="text-muted-foreground">{device.hostname ?? t('unreported')}</span>
        </SettingRow>
        <SettingRow title={t('hardwareArchLabel')}>
          <span className="text-muted-foreground">{device.arch ?? t('unreported')}</span>
        </SettingRow>
        <SettingRow title={t('hardwareOsLabel')}>
          <span className="text-muted-foreground">{formatPlatformTitle(device.platform) ?? t('unreported')}</span>
        </SettingRow>
        <SettingRow title={t('hardwareAgentsLabel')}>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
            {agents.length > 0 ? <AgentMarks agents={agents} /> : <span>{tDevices('noAgentYet')}</span>}
          </div>
        </SettingRow>
      </SettingsSection>

      <div className="flex flex-col gap-2">
        {policyRead.error && !policy ? (
          <SettingsSaveError message={t('policyLoadError')} retryLabel={common('retry')} onRetry={() => { void policyRead.mutate() }} />
        ) : null}
        {failedPolicyPatch !== null ? (
          <SettingsSaveError message={t('policySaveError')} retryLabel={common('retry')} onRetry={() => { void savePolicy(failedPolicyPatch) }} />
        ) : null}
        <SettingsSection id="device-access-heading" title={t('accessHeading')} description={t('accessDescription')}>
          <SettingRow title={t('deviceScopeLabel')} description={t('deviceScopeDescription')}>
            <span className="text-muted-foreground">{t('scopePersonal')}</span>
          </SettingRow>
          <SettingRow
            title={tDevices('allowScheduling')}
            description={policy
              ? t('schedulingSlotsDescription', { active: policy.scheduling.activeRuns, max: policy.scheduling.maxConcurrentRuns })
              : t('schedulingDescription')}
          >
            <Switch
              aria-label={tDevices('allowSchedulingTo', { name: device.name })}
              checked={policy?.schedulingEnabled ?? device.enabled}
              disabled={policyBusy || Boolean(policyRead.error && !policy)}
              onCheckedChange={checked => { void savePolicy({ schedulingEnabled: checked }) }}
            />
          </SettingRow>
          <SettingRow
            title={t('computerUseLabel')}
            description={policy?.computerUse.installed && policy.computerUse.version
              ? t('computerUseInstalledVersion', { version: policy.computerUse.version })
              : t('computerUseDescription')}
          >
            <Switch
              aria-label={t('computerUseAriaLabel', { name: device.name })}
              checked={policy?.computerUseEnabled ?? false}
              disabled={!policy || policyBusy}
              onCheckedChange={checked => { void savePolicy({ computerUseEnabled: checked }) }}
            />
          </SettingRow>
        </SettingsSection>
      </div>

      <div className="flex flex-col gap-2">
        {reposRead.error && !reposRead.data ? (
          <SettingsSaveError message={t('repositoriesLoadError')} retryLabel={common('retry')} onRetry={() => { void reposRead.mutate() }} />
        ) : null}
        <SettingsSection
          id="device-repositories-heading"
          title={t('repositoriesHeading')}
          description={t('repositoriesDescription')}
          action={
            <Button type="button" {...settingsSectionAction} disabled={repoBusy} onClick={() => setRepoDialog({ mode: 'add' })}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t('addRepositoryButton')}
            </Button>
          }
        >
          {reposRead.isLoading && !reposRead.data ? (
            <SettingsLoading bare label={t('repositoriesHeading')} rows={2} />
          ) : !repositories || repositories.length === 0 ? (
            <SettingRow title={t('emptyRepositories')} />
          ) : (
            repositories.map(item => {
              const subtitle = [
                item.localPath ? item.repoKey : item.remoteUrl,
                item.baseBranch,
                item.verifyCommand,
              ].filter(Boolean).join(' · ')
              return (
                <SettingRow key={item.id} title={item.localPath ?? item.repoKey} description={subtitle || undefined}>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={repoBusy}
                      onClick={() => setRepoDialog({ mode: 'edit', item })}
                    >
                      {t('editRepositoryButton')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={repoBusy}
                      aria-label={t('removeRepositoryAriaLabel', { name: item.repoKey })}
                      onClick={() => { setRepoDeleteError(''); setRemovingRepo(item) }}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </SettingRow>
              )
            })
          )}
        </SettingsSection>
      </div>

      <SettingsSection id="device-identity-heading" title={t('identityHeading')}>
        <SettingRow title={t('pairedAtLabel')}>
          <span className="text-muted-foreground">
            {matchedToken
              ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(matchedToken.createdAt))
              : t('unreported')}
          </span>
        </SettingRow>
        <SettingRow title={t('ownerLabel')}>
          <span className="text-muted-foreground">{t('ownerSelf')}</span>
        </SettingRow>
        {workspaceName ? (
          <SettingRow title={t('workspaceLabel')}>
            <span className="text-muted-foreground">{workspaceName}</span>
          </SettingRow>
        ) : null}
        <SettingRow title={t('tokenLabel')}>
          <span className="font-mono text-xs text-muted-foreground">
            {matchedToken ? (matchedToken.name || matchedToken.id.slice(0, 8)) : t('sessionEnrolled')}
          </span>
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="device-management-heading" title={t('managementHeading')}>
        <SettingRow title={t('whenUnavailableLabel')}>
          <Button type="button" variant="outline" size="sm" onClick={() => onReconnect(device)}>
            {tDevices('reconnect')}
          </Button>
        </SettingRow>
        <SettingRow title={tDevices('actions.restart')}>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void command('restart') }}>
            {t('restartActionButton')}
          </Button>
        </SettingRow>
        <SettingRow title={tDevices('actions.update')}>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void command('update') }}>
            {t('updateActionButton')}
          </Button>
        </SettingRow>
        <SettingRow title={tDevices('actions.redetect')}>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void command('redetect') }}>
            {t('redetectActionButton')}
          </Button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection id="device-danger-heading" title={t('dangerHeading')}>
        <SettingRow title={t('removeDeviceTitle')} description={t('removeDeviceDescription')}>
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
            {t('removeButton')}
          </Button>
        </SettingRow>
      </SettingsSection>

      <Dialog open={renaming} onOpenChange={open => { if (!busy) setRenaming(open) }}>
        <DialogContent closeLabel={common('close')} className="sm:max-w-md" aria-describedby={undefined}>
          <form
            className="flex flex-col gap-4"
            onSubmit={async event => {
              event.preventDefault()
              if (!canRenameDevice(device.name, nameDraft) || busy) return
              if (await rename(nameDraft)) setRenaming(false)
            }}
          >
            <DialogHeader><DialogTitle>{tDevices('rename.title')}</DialogTitle></DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`detail-rename-${device.id}`} className="sr-only">{tDevices('rename.label')}</FieldLabel>
                <Input
                  id={`detail-rename-${device.id}`}
                  autoFocus
                  maxLength={DEVICE_NAME_MAX}
                  value={nameDraft}
                  onChange={event => setNameDraft(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setRenaming(false)}>
                {tDevices('rename.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!canRenameDevice(device.name, nameDraft) || busy}>
                {tDevices('rename.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeviceRepositoryDialog
        target={repoDialog}
        reposUrl={reposUrl}
        onClose={() => setRepoDialog(null)}
        onSaved={async () => {
          setRepoDialog(null)
          await reposRead.mutate()
          onChanged()
        }}
      />

      <AlertDialog open={removingRepo !== null} onOpenChange={open => { if (!open && !repoBusy) { setRemovingRepo(null); setRepoDeleteError('') } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeRepositoryTitle', { name: removingRepo?.repoKey ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('removeRepositoryDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {repoDeleteError ? <FieldError className="text-xs">{repoDeleteError}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={repoBusy}>{common('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={repoBusy} onClick={event => { event.preventDefault(); void confirmDeleteRepository() }}>
              {t('removeButton')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removing} onOpenChange={open => { if (!open && !busy) setRemoving(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tDevices('remove.title', { name: device.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {device.online ? tDevices('remove.uninstall', { name: device.name }) : tDevices('remove.offline', { name: device.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{tDevices('remove.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async event => {
                event.preventDefault()
                if (await remove()) {
                  setRemoving(false)
                  onBack()
                }
              }}
            >
              {tDevices('remove.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function DeviceRepositoryDialog({
  target,
  reposUrl,
  onClose,
  onSaved,
}: {
  target: { mode: 'add' } | { mode: 'edit'; item: DeviceRepositoryItem } | null
  reposUrl: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('Settings.devicesDetail')
  const common = useTranslations('Common')
  const translateError = useActionError()
  const editing = target?.mode === 'edit' ? target.item : null

  const [repoKey, setRepoKey] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const [verifyCommand, setVerifyCommand] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!target) return
    setError('')
    if (target.mode === 'edit') {
      setRepoKey(target.item.repoKey)
      setLocalPath(target.item.localPath ?? '')
      setBaseBranch(target.item.baseBranch ?? '')
      setVerifyCommand(target.item.verifyCommand ?? '')
    } else {
      setRepoKey('')
      setLocalPath('')
      setBaseBranch('main')
      setVerifyCommand('')
    }
  }, [target])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!target || saving) return
    const trimmedRepo = repoKey.trim()
    const trimmedPath = localPath.trim()
    const trimmedBranch = baseBranch.trim()
    const trimmedVerify = verifyCommand.trim()

    if (!editing && !trimmedRepo) {
      setError(t('repoKeyRequired'))
      return
    }
    if (trimmedPath && !trimmedPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmedPath)) {
      setError(t('localPathMustBeAbsolute'))
      return
    }

    setSaving(true)
    setError('')
    const result = editing
      ? await requestJson<DeviceRepositoryItem>(reposUrl, {
          method: 'PATCH',
          body: JSON.stringify({
            id: editing.id,
            repoKey: editing.repoKey,
            localPath: trimmedPath || null,
            baseBranch: trimmedBranch || null,
            verifyCommand: trimmedVerify || null,
          }),
        })
      : await requestJson<DeviceRepositoryItem>(reposUrl, {
          method: 'PUT',
          body: JSON.stringify({
            repoKey: trimmedRepo,
            localPath: trimmedPath || null,
            baseBranch: trimmedBranch || null,
            verifyCommand: trimmedVerify || null,
          }),
        })
    setSaving(false)
    if (!result.ok) {
      setError(translateError(result.code))
      return
    }
    await onSaved()
  }

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent closeLabel={common('close')} className="sm:max-w-md" aria-describedby={undefined}>
        <form className="flex flex-col gap-4" onSubmit={event => { void submit(event) }}>
          <DialogHeader>
            <DialogTitle>{editing ? t('editRepositoryTitle') : t('addRepositoryTitle')}</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="device-repo-key">{t('repoKeyLabel')}</FieldLabel>
              <Input
                id="device-repo-key"
                required
                disabled={saving || Boolean(editing)}
                maxLength={4000}
                autoCapitalize="off"
                spellCheck={false}
                placeholder="owner/repo"
                value={repoKey}
                onChange={event => { setRepoKey(event.target.value); setError('') }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-repo-local-path">{t('localPathLabel')}</FieldLabel>
              <Input
                id="device-repo-local-path"
                disabled={saving}
                maxLength={1024}
                autoCapitalize="off"
                spellCheck={false}
                placeholder="/Users/alex/projects/repo"
                value={localPath}
                onChange={event => { setLocalPath(event.target.value); setError('') }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-repo-branch">{t('baseBranchLabel')}</FieldLabel>
              <Input
                id="device-repo-branch"
                disabled={saving}
                maxLength={255}
                autoCapitalize="off"
                spellCheck={false}
                placeholder="main"
                value={baseBranch}
                onChange={event => { setBaseBranch(event.target.value); setError('') }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="device-repo-verify">{t('verifyCommandLabel')}</FieldLabel>
              <Input
                id="device-repo-verify"
                disabled={saving}
                maxLength={2000}
                autoCapitalize="off"
                spellCheck={false}
                placeholder="pnpm test"
                value={verifyCommand}
                onChange={event => { setVerifyCommand(event.target.value); setError('') }}
              />
            </Field>
            {error ? <FieldError role="alert">{error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={onClose}>
              {common('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={saving || (!editing && !repoKey.trim())}>
              {saving ? common('saving') : common('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
