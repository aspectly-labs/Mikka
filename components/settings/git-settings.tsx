'use client'

import { useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import type { ResolvedSetting, SettingScope, SettingSource, SettingValue, SettingsView } from '@mikka/protocol/settings'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingSelect, SettingSwitch, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useLiveKey } from '@/hooks/use-live-key'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'

export interface GitSettingsProps {
  workspaceId?: string
  personal?: boolean
  admin?: boolean
  userName?: string
  userEmail?: string
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

function hasForbiddenIdentityChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f || code === 0x3c || code === 0x3e) return true
  }
  return false
}

function validateAuthorName(raw: string): string | null {
  const trimmed = raw.trim()
  if (raw !== '' && trimmed.length === 0) return null
  if (trimmed.length > 100 || hasForbiddenIdentityChar(trimmed)) return null
  return trimmed
}

function validateAuthorEmail(raw: string): string | null {
  const trimmed = raw.trim()
  if (raw !== '' && trimmed.length === 0) return null
  if (trimmed === '') return ''
  if (trimmed.length > 254 || hasForbiddenIdentityChar(trimmed) || !EMAIL_PATTERN.test(trimmed)) return null
  return trimmed
}

function personalGitKey(workspaceId: string) {
  return ['settings:personal:workspace', workspaceId] as const
}

async function patchScopeSettings(scope: SettingScope, workspaceId: string, values: Record<string, SettingValue | null>): Promise<SettingsView> {
  const url = scope === 'personal'
    ? `/api/settings/personal?workspaceId=${encodeURIComponent(workspaceId)}`
    : `/api/settings/workspace/${encodeURIComponent(workspaceId)}`
  const response = await fetch(withBasePath(url), {
    method: 'PATCH',
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group }),
  })
  if (!response.ok) throw new Error('Settings reset failed')
  return response.json() as Promise<SettingsView>
}

/**
 * Git 与拉取请求 (Frame 19, 1508:2).
 * Personal override vs Workspace default tabs; wires `gitAuthorName` and `gitAuthorEmail`
 * (`GET/PATCH /api/settings/personal?workspaceId=...`, `/api/settings/workspace/:workspaceId`,
 * and `POST .../reset` `{ group: 'git' }`) with `{ value, source }` inheritance badges.
 * GPG signed commits (`pro:blocked`) and unmerged P5 pull-request keys show honest `· 待接入`.
 */
export function GitSettings({ workspaceId, personal = false, admin = false, userName, userEmail }: GitSettingsProps) {
  const t = useTranslations('Settings.gitPage')
  const [scope, setScope] = useState<SettingScope>('personal')

  if (!workspaceId) {
    return <SettingsLoading label={t('gitTitle')} rows={4} />
  }

  return <GitSettingsScopeBody
    key={`${workspaceId}:${scope}`}
    workspaceId={workspaceId}
    scope={scope}
    onScopeChange={setScope}
    canEditWorkspace={Boolean(admin || personal)}
    userName={userName}
    userEmail={userEmail}
  />
}

function GitSettingsScopeBody({
  workspaceId,
  scope,
  onScopeChange,
  canEditWorkspace,
  userName,
  userEmail,
}: {
  workspaceId: string
  scope: SettingScope
  onScopeChange: (next: SettingScope) => void
  canEditWorkspace: boolean
  userName?: string
  userEmail?: string
}) {
  const t = useTranslations('Settings.gitPage')
  const common = useTranslations('Common')
  const { mutate: mutateGlobal } = useSWRConfig()
  const pKey = personalGitKey(workspaceId)
  const wKey = settingsKeys.workspaceRegistry(workspaceId)
  const activeKey = scope === 'personal' ? pKey : wKey
  const activeUrl = scope === 'personal'
    ? `/api/settings/personal?workspaceId=${encodeURIComponent(workspaceId)}`
    : `/api/settings/workspace/${encodeURIComponent(workspaceId)}`

  const read = useSWR<SettingsView>(activeKey, () => fetchSettingsData<SettingsView>(activeUrl), settingsReadOptions)
  useLiveKey('workspace_settings', workspaceId, [unstable_serialize(pKey), unstable_serialize(wKey)], workspaceId)

  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState<string | null>(null)
  const [branchPrefixDraft, setBranchPrefixDraft] = useState<string | null>(null)
  const [titlePrefixDraft, setTitlePrefixDraft] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [busyField, setBusyField] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [failedPatch, setFailedPatch] = useState<Record<string, SettingValue | null> | null>(null)
  const [resetFailed, setResetFailed] = useState(false)

  const canEdit = scope === 'personal' ? true : canEditWorkspace
  const pendingTag = t('pendingBadge')

  function sourceLabel(source: SettingSource) {
    if (source === 'personal') return t('sourcePersonal')
    if (source === 'workspace') return t('sourceWorkspace')
    return t('sourceDefault')
  }

  function titledWithSource(title: string, entry: ResolvedSetting | undefined) {
    return t('titleWithSource', { title, source: sourceLabel(entry?.source ?? 'default') })
  }

  if (read.isLoading && !read.data) {
    return <>
      <ScopeHeader scope={scope} onScopeChange={onScopeChange} canReset={false} resetting={false} onReset={async () => {}} />
      <SettingsLoading label={t('gitTitle')} rows={4} />
    </>
  }

  if (read.error && !read.data) {
    return <>
      <ScopeHeader scope={scope} onScopeChange={onScopeChange} canReset={false} resetting={false} onReset={async () => {}} />
      <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
    </>
  }

  const values = read.data?.values ?? {}
  const authorNameEntry = values.gitAuthorName
  const authorEmailEntry = values.gitAuthorEmail
  const currentName = typeof authorNameEntry?.value === 'string' ? authorNameEntry.value : ''
  const currentEmail = typeof authorEmailEntry?.value === 'string' ? authorEmailEntry.value : ''

  const branchPrefixEntry = values.prBranchPrefix
  const titlePrefixEntry = values.prTitlePrefix
  const prDraftEntry = values.prDraft
  const prAutoMergeEntry = values.prAutoMerge
  const hasBranchPrefix = Boolean(branchPrefixEntry)
  const hasTitlePrefix = Boolean(titlePrefixEntry)
  const hasPrDraft = Boolean(prDraftEntry)
  const hasPrAutoMerge = Boolean(prAutoMergeEntry)

  const gitEntries = [authorNameEntry, authorEmailEntry, branchPrefixEntry, titlePrefixEntry, prDraftEntry, prAutoMergeEntry]
  const hasScopeOverrides = gitEntries.some(entry => entry?.source === scope)

  async function applyPatch(fieldKey: string, patchValues: Record<string, SettingValue | null>) {
    setBusyField(fieldKey)
    setFailedPatch(null)
    setResetFailed(false)
    setValidationError(null)
    try {
      const updated = await patchScopeSettings(scope, workspaceId, patchValues)
      await read.mutate(updated, { revalidate: false })
      if (scope === 'workspace') void mutateGlobal(pKey)
    } catch {
      setFailedPatch(patchValues)
    } finally {
      setBusyField(null)
    }
  }

  async function handleReset() {
    setResetting(true)
    setResetFailed(false)
    setFailedPatch(null)
    setValidationError(null)
    try {
      const updated = await resetScopeGroup(scope, workspaceId, 'git')
      setNameDraft(null)
      setEmailDraft(null)
      setBranchPrefixDraft(null)
      setTitlePrefixDraft(null)
      await read.mutate(updated, { revalidate: false })
      if (scope === 'workspace') void mutateGlobal(pKey)
    } catch {
      setResetFailed(true)
    } finally {
      setResetting(false)
    }
  }

  function commitAuthorName() {
    if (nameDraft === null) return
    const normalized = validateAuthorName(nameDraft)
    if (normalized === null) {
      setValidationError(t('invalidAuthorName'))
      return
    }
    setValidationError(null)
    setNameDraft(null)
    if (normalized === currentName) return
    void applyPatch('gitAuthorName', { gitAuthorName: normalized })
  }

  function commitAuthorEmail() {
    if (emailDraft === null) return
    const normalized = validateAuthorEmail(emailDraft)
    if (normalized === null) {
      setValidationError(t('invalidAuthorEmail'))
      return
    }
    setValidationError(null)
    setEmailDraft(null)
    if (normalized === currentEmail) return
    void applyPatch('gitAuthorEmail', { gitAuthorEmail: normalized })
  }

  const currentBranchPrefix = typeof branchPrefixEntry?.value === 'string' ? branchPrefixEntry.value : 'mikka/'
  const currentTitlePrefix = typeof titlePrefixEntry?.value === 'string' ? titlePrefixEntry.value : ''
  const currentPrDraft = Boolean(prDraftEntry?.value)
  const currentPrAutoMerge = Boolean(prAutoMergeEntry?.value)

  function commitBranchPrefix() {
    if (branchPrefixDraft === null) return
    const next = branchPrefixDraft.trim()
    setBranchPrefixDraft(null)
    if (!next || next === currentBranchPrefix) return
    void applyPatch('prBranchPrefix', { prBranchPrefix: next })
  }

  function commitTitlePrefix() {
    if (titlePrefixDraft === null) return
    const next = titlePrefixDraft.trim()
    setTitlePrefixDraft(null)
    if (next === currentTitlePrefix) return
    void applyPatch('prTitlePrefix', { prTitlePrefix: next })
  }

  return <>
    <ScopeHeader
      scope={scope}
      onScopeChange={onScopeChange}
      canReset={canEdit && hasScopeOverrides}
      resetting={resetting}
      onReset={handleReset}
    />

    <SettingsSection id="git-identity" title={t('gitTitle')} description={t('gitDescription')}>
      <SettingRow title={titledWithSource(t('authorName'), authorNameEntry)} description={t('authorNameHint')}>
        {canEdit
          ? <Input
              aria-label={t('authorName')}
              className="w-56 max-w-full"
              maxLength={100}
              placeholder={userName || t('authorNamePlaceholder')}
              value={nameDraft ?? currentName}
              disabled={busyField === 'gitAuthorName' || resetting}
              onChange={event => { setNameDraft(event.target.value); if (validationError) setValidationError(null) }}
              onBlur={commitAuthorName}
              onKeyDown={event => {
                if (event.key === 'Enter') commitAuthorName()
                if (event.key === 'Escape') { setNameDraft(null); setValidationError(null) }
              }}
            />
          : <span className="text-muted-foreground">{currentName || t('defaultAuthorFallback')}</span>}
      </SettingRow>

      <SettingRow title={titledWithSource(t('authorEmail'), authorEmailEntry)} description={t('authorEmailHint')}>
        {canEdit
          ? <Input
              type="email"
              aria-label={t('authorEmail')}
              className="w-56 max-w-full"
              maxLength={254}
              placeholder={userEmail || t('authorEmailPlaceholder')}
              value={emailDraft ?? currentEmail}
              disabled={busyField === 'gitAuthorEmail' || resetting}
              onChange={event => { setEmailDraft(event.target.value); if (validationError) setValidationError(null) }}
              onBlur={commitAuthorEmail}
              onKeyDown={event => {
                if (event.key === 'Enter') commitAuthorEmail()
                if (event.key === 'Escape') { setEmailDraft(null); setValidationError(null) }
              }}
            />
          : <span className="text-muted-foreground">{currentEmail || t('defaultAuthorFallback')}</span>}
      </SettingRow>

      <SettingRow title={withPendingSuffix(t('signedCommits'), pendingTag)} description={t('signedCommitsHint')}>
        <SettingSwitch label={t('signedCommits')} checked={false} disabled onCheckedChange={() => {}} />
      </SettingRow>

      <SettingRow
        title={hasBranchPrefix ? titledWithSource(t('branchPrefix'), branchPrefixEntry) : withPendingSuffix(t('branchPrefix'), pendingTag)}
        description={t('branchPrefixHint')}
      >
        {hasBranchPrefix && canEdit
          ? <Input
              aria-label={t('branchPrefix')}
              className="w-40 max-w-full font-mono"
              maxLength={80}
              placeholder={t('branchPrefixPlaceholder')}
              value={branchPrefixDraft ?? currentBranchPrefix}
              disabled={busyField === 'prBranchPrefix' || resetting}
              onChange={event => setBranchPrefixDraft(event.target.value)}
              onBlur={commitBranchPrefix}
              onKeyDown={event => {
                if (event.key === 'Enter') commitBranchPrefix()
                if (event.key === 'Escape') setBranchPrefixDraft(null)
              }}
            />
          : <span className="font-mono text-muted-foreground">{hasBranchPrefix ? currentBranchPrefix : 'mikka/'}</span>}
      </SettingRow>

      <SettingRow
        title={hasTitlePrefix ? titledWithSource(t('titlePrefix'), titlePrefixEntry) : withPendingSuffix(t('titlePrefix'), pendingTag)}
        description={t('titlePrefixHint')}
      >
        {hasTitlePrefix && canEdit
          ? <Input
              aria-label={t('titlePrefix')}
              className="w-40 max-w-full"
              maxLength={80}
              placeholder={t('titlePrefixPlaceholder')}
              value={titlePrefixDraft ?? currentTitlePrefix}
              disabled={busyField === 'prTitlePrefix' || resetting}
              onChange={event => setTitlePrefixDraft(event.target.value)}
              onBlur={commitTitlePrefix}
              onKeyDown={event => {
                if (event.key === 'Enter') commitTitlePrefix()
                if (event.key === 'Escape') setTitlePrefixDraft(null)
              }}
            />
          : <span className="text-muted-foreground">{hasTitlePrefix && currentTitlePrefix ? currentTitlePrefix : t('noneValue')}</span>}
      </SettingRow>
    </SettingsSection>

    {validationError ? <FieldError className="px-1">{validationError}</FieldError> : null}

    <SettingsSection
      id="git-pull-requests"
      title={t('prTitle')}
      description={scope === 'personal' ? t('prDescriptionPersonal') : t('prDescriptionWorkspace')}
    >
      <SettingRow
        title={hasPrDraft ? titledWithSource(t('prNewState'), prDraftEntry) : withPendingSuffix(t('prNewState'), pendingTag)}
        description={t('prNewStateHint')}
      >
        {hasPrDraft && canEdit
          ? <SettingSelect
              fluid
              label={t('prNewState')}
              value={currentPrDraft ? 'draft' : 'ready'}
              disabled={busyField === 'prDraft' || resetting}
              options={[
                { value: 'ready', label: t('prReady') },
                { value: 'draft', label: t('prDraft') },
              ]}
              onValueChange={value => {
                if (value !== 'ready' && value !== 'draft') return
                const next = value === 'draft'
                if (next !== currentPrDraft) void applyPatch('prDraft', { prDraft: next })
              }}
            />
          : <span className="text-muted-foreground">{hasPrDraft && currentPrDraft ? t('prDraft') : t('prReady')}</span>}
      </SettingRow>

      <SettingRow
        title={hasPrAutoMerge ? titledWithSource(t('prAutoMerge'), prAutoMergeEntry) : withPendingSuffix(t('prAutoMerge'), pendingTag)}
        description={t('prAutoMergeHint')}
      >
        {hasPrAutoMerge && canEdit
          ? <SettingSwitch
              label={t('prAutoMerge')}
              checked={currentPrAutoMerge}
              disabled={busyField === 'prAutoMerge' || resetting}
              onCheckedChange={checked => { void applyPatch('prAutoMerge', { prAutoMerge: checked }) }}
            />
          : <span className="text-muted-foreground">{hasPrAutoMerge && currentPrAutoMerge ? t('onValue') : t('offValue')}</span>}
      </SettingRow>

      <SettingRow title={withPendingSuffix(t('openInMikka'), pendingTag)} description={t('openInMikkaHint')}>
        <span className="text-muted-foreground">{t('showValue')}</span>
      </SettingRow>

      <SettingRow title={withPendingSuffix(t('humanFeedback'), pendingTag)} description={t('humanFeedbackHint')}>
        <span className="text-muted-foreground">{t('followUpValue')}</span>
      </SettingRow>

      <SettingRow title={withPendingSuffix(t('ciResult'), pendingTag)} description={t('ciResultHint')}>
        <span className="text-muted-foreground">{t('followUpValue')}</span>
      </SettingRow>

      <SettingRow title={withPendingSuffix(t('conflictHandling'), pendingTag)} description={t('conflictHandlingHint')}>
        <span className="text-muted-foreground">{t('followUpValue')}</span>
      </SettingRow>
    </SettingsSection>

    {failedPatch ? <SettingsSaveError message={t('saveError')} retryLabel={common('retry')} onRetry={() => { void applyPatch('retry', failedPatch) }} /> : null}
    {resetFailed ? <SettingsSaveError message={t('resetError')} retryLabel={common('retry')} onRetry={() => { void handleReset() }} /> : null}
  </>
}

function ScopeHeader({
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
  const t = useTranslations('Settings.gitPage')
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ToggleGroup
        aria-label={t('scopeLabel')}
        variant="segment"
        size="sm"
        spacing={0.5}
        value={[scope]}
        onValueChange={values => {
          const next = values[0]
          if (next === 'personal' || next === 'workspace') onScopeChange(next)
        }}
      >
        <ToggleGroupItem value="personal">{t('scopePersonal')}</ToggleGroupItem>
        <ToggleGroupItem value="workspace">{t('scopeWorkspace')}</ToggleGroupItem>
      </ToggleGroup>
      {canReset ? (
        <Button type="button" variant="ghost" size="sm" busy={resetting} onClick={onReset}>
          {scope === 'personal' ? t('resetInherit') : t('resetDefaults')}
        </Button>
      ) : null}
    </div>
  )
}
