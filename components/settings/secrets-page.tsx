'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { z } from 'zod'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { ChevronRight, Ellipsis, Eye, EyeOff, FileUp, KeyRound, Lock, Plus, Search, SquareTerminal } from '@/components/icons'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { SiteIcon } from '@/components/credentials/site-icon'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { SearchInput } from '@/components/ui/search-input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection, settingsSelectTriggerClass } from '@/components/settings/primitives'
import type { SettingsSecretsProps } from '@/components/slots/settings-secrets-contract'
import {
  SECRET_REPOSITORY,
  useDotenvFile,
  useDotenvPreview,
  useMySecretEditor,
  useMySecretImport,
  useMySecrets,
  useSavedLoginEditor,
  useSavedLoginUsage,
  useSavedLogins,
  useWorkspaceSecretEditor,
  useWorkspaceSecretImport,
  useWorkspaceSecrets,
  withoutScheme,
  writableScopes,
  type SecretScope,
} from '@/hooks/settings/use-secrets'
import { isReservedEnvName, SECRET_NAME, SECRET_NOTE_MAX, SECRET_VALUE_MAX_BYTES } from '@/lib/secrets/format'
import { secretActionAllowed, type WorkspaceRole } from '@/lib/secrets/permissions'
import type { WorkspaceSecretView } from '@/lib/secrets/store'
import type { UserSecretView } from '@/lib/secrets/user-store'
import type { SavedLogin } from '@/lib/settings/saved-logins'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { cn } from '@/lib/utils'

export type { SecretsSide } from '@/components/slots/settings-secrets-contract'

type ScopeFilter = 'all' | 'workspace' | 'repository'
type ConflictStrategy = 'replace' | 'skip'
type SecretKindChoice = 'secret' | 'env'

type WorkspaceModalState =
  | { kind: 'new' }
  | { kind: 'edit'; secret: WorkspaceSecretView }
  | { kind: 'bulk' }

type PersonalModalState =
  | { kind: 'new' }
  | { kind: 'edit'; secret: UserSecretView }
  | { kind: 'bulk' }

type LoginModalState =
  | { kind: 'new' }
  | { kind: 'password'; login: SavedLogin }

const secretCreateValidator = z.object({
  name: z.string().trim().regex(SECRET_NAME).refine(val => !isReservedEnvName(val)),
  kind: z.enum(['secret', 'env']),
  value: z.string().min(1).refine(val => new TextEncoder().encode(val).byteLength <= SECRET_VALUE_MAX_BYTES),
  note: z.string().trim().max(SECRET_NOTE_MAX),
})

const dotenvImportValidator = z.object({
  text: z.string().min(1),
  masked: z.boolean(),
  scope: z.enum(['workspace', 'repository']),
  onConflict: z.enum(['replace', 'skip']),
})

const savedLoginValidator = z.object({
  site: z.string().trim().min(1).max(255),
  account: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
})

/**
 * 密钥与环境 / 密钥与登录 (frame 1645:10562 / 41): write-only workspace secrets,
 * personal secrets and site logins with masked `••••••••` indicators and Zod modals.
 */
export function SecretsPage({ side, workspaceId, workspaceName, waiting }: SettingsSecretsProps) {
  const tp = useTranslations('Settings.polish')
  const [notice, setNotice] = useState<string | null>(null)
  const [wsTrigger, setWsTrigger] = useState<WorkspaceModalState | null>(null)
  const [myTrigger, setMyTrigger] = useState<PersonalModalState | null>(null)

  const showQuickActions = Boolean(workspaceId)
  const openPrimaryNew = () => {
    setNotice(null)
    if (side === 'mine') setMyTrigger({ kind: 'new' })
    else setWsTrigger({ kind: 'new' })
  }
  const openPrimaryBulk = () => {
    setNotice(null)
    if (side === 'mine') setMyTrigger({ kind: 'bulk' })
    else setWsTrigger({ kind: 'bulk' })
  }

  return <div className="flex flex-col gap-6">
    <p className="-mt-3 text-xs text-muted-foreground">{tp('secretsLead')}</p>
    {showQuickActions && <SettingsSection id="secrets-quick-actions">
      <SettingRow icon={<SquareTerminal className="size-4 shrink-0 text-muted-foreground" />} title={tp('secretsWriteOnlyTitle')}>
        <Button type="button" variant="ghost" size="sm" onClick={openPrimaryNew}>{tp('addSecretAction')}</Button>
      </SettingRow>
      <SettingRow icon={<FileUp className="size-4 shrink-0 text-muted-foreground" />} title={tp('bulkImportEnv')} description={tp('bulkImportEnvHint')}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={tp('bulkImportEnv')} onClick={openPrimaryBulk}><ChevronRight /></Button>
      </SettingRow>
    </SettingsSection>}
    {notice && <p role="status" className="px-1 text-sm text-muted-foreground">{notice}</p>}
    {side === 'workspace' && (workspaceId
      ? <WorkspaceSecretsCard
          key={workspaceId}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          externalModal={wsTrigger}
          onClearExternalModal={() => setWsTrigger(null)}
          onNotice={setNotice}
        />
      : waiting)}
    <PersonalSecretsAndLoginsCard
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      externalModal={myTrigger}
      onClearExternalModal={() => setMyTrigger(null)}
      onNotice={setNotice}
    />
  </div>
}

function WorkspaceSecretsCard({
  workspaceId,
  workspaceName,
  externalModal,
  onClearExternalModal,
  onNotice,
}: {
  workspaceId: string
  workspaceName?: string
  externalModal: WorkspaceModalState | null
  onClearExternalModal: () => void
  onNotice: (message: string | null) => void
}) {
  const t = useTranslations('Settings.secrets')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const locale = useLocale()
  const list = useWorkspaceSecrets(workspaceId)
  const [filter, setFilter] = useState<ScopeFilter>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [localModal, setLocalModal] = useState<WorkspaceModalState | null>(null)
  const [deleting, setDeleting] = useState<WorkspaceSecretView | null>(null)

  const activeModal = externalModal ?? localModal
  const modalPresence = usePresence(activeModal)
  const closeModal = () => {
    setLocalModal(null)
    onClearExternalModal()
  }

  const { secrets, role } = list
  const canCreate = role !== null && writableScopes(role).length > 0
  const canDelete = role !== null && secretActionAllowed(role, 'secret.delete')
  const hasRepositorySecrets = (secrets ?? []).some(secret => secret.scopeType === 'repository')
  const needle = query.trim().toLowerCase()
  const shown = (secrets ?? []).filter(secret => {
    if (filter !== 'all' && secret.scopeType !== filter) return false
    if (!needle) return true
    return secret.name.toLowerCase().includes(needle) || secret.scopeRef.toLowerCase().includes(needle) || secret.note.toLowerCase().includes(needle)
  })

  const filterOptions = (['all', 'workspace', 'repository'] as const).map(value => ({ value, label: t(`filters.${value}`) }))

  return <>
    <SettingsSection id="secrets-heading" title={tp('workspaceSecretsHeading')} description={tp('workspaceSecretsHint')}>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <span className="text-xs font-medium text-foreground">{tp('workspaceSecretsCount', { count: secrets?.length ?? 0 })}</span>
        <div className="flex items-center gap-1">
          {hasRepositorySecrets && <Select value={filter} items={filterOptions} onValueChange={value => { if (value) setFilter(value as ScopeFilter) }}>
            <SelectTrigger size="sm" aria-label={t('filterLabel')} className={cn(settingsSelectTriggerClass, 'w-24')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{filterOptions.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>}
          <Button type="button" variant="ghost" size="icon-sm" aria-label={tp('searchSecrets')} aria-pressed={searchOpen} onClick={() => setSearchOpen(open => !open)}><Search /></Button>
          {canCreate && <Button type="button" variant="ghost" size="icon-sm" aria-label={tp('addSecretAction')} onClick={() => { onNotice(null); setLocalModal({ kind: 'new' }) }}><Plus /></Button>}
        </div>
      </div>
      {searchOpen && <div className="px-4 py-2">
        <SearchInput value={query} placeholder={tp('searchSecretsPlaceholder')} aria-label={tp('searchSecretsPlaceholder')} onChange={event => setQuery(event.target.value)} />
      </div>}
      {list.loading && <SettingsLoading label={t('loading')} rows={2} bare />}
      {list.error && <SettingsSaveError message={list.error} retryLabel={common('retry')} onRetry={list.reload} />}
      {!list.loading && !list.error && secrets?.length === 0 && <div className="flex items-center justify-between gap-3 px-4 py-4">
        <span className="text-sm text-muted-foreground">{t('empty')}</span>
        {canCreate && <Button type="button" variant="outline" size="sm" onClick={() => { onNotice(null); setLocalModal({ kind: 'new' }) }}><Plus data-icon="inline-start" />{tp('addSecretAction')}</Button>}
      </div>}
      {!list.loading && !list.error && (secrets?.length ?? 0) > 0 && shown.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">{tp('noMatchingSecrets')}</p>}
      {shown.map(secret => {
        const editable = role !== null && secretActionAllowed(role, 'secret.replace', [secret])
        const scopeText = secret.scopeType === 'workspace' ? t('workspaceGroup') : secret.scopeRef
        const meta = [scopeText, tp('secretUpdatedAgo', { when: relativeTime(secret.updatedAt, locale) }), secret.note].filter(Boolean).join(' · ')
        return <div key={secret.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono text-sm font-medium text-foreground">{secret.name}</span>
                {secret.kind === 'secret'
                  ? <span aria-label={t('masked')} className="font-mono text-xs tracking-widest text-muted-foreground">••••••••</span>
                  : <Badge variant="outline">{t('notMasked')}</Badge>}
              </div>
              <p className="truncate text-xs text-muted-foreground">{meta}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge className="bg-success/15 text-success-foreground">{tp('secretConfigured')}</Badge>
            {(editable || canDelete) && <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('actions', { name: secret.name })} />}><Ellipsis /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuGroup>
                  {editable && <DropdownMenuItem onClick={() => { onNotice(null); setLocalModal({ kind: 'edit', secret }) }}>{t('edit')}</DropdownMenuItem>}
                  {canDelete && <DropdownMenuItem variant="destructive" onClick={() => setDeleting(secret)}>{common('delete')}</DropdownMenuItem>}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>}
          </div>
        </div>
      })}
    </SettingsSection>
    {modalPresence.value && role && (modalPresence.value.kind === 'bulk'
      ? <WorkspaceBulkDialog
          role={role}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          open={modalPresence.open}
          onOpenChangeComplete={modalPresence.onOpenChangeComplete}
          onClose={saved => {
            closeModal()
            if (saved) {
              onNotice(saved.notice)
              list.reload()
            }
          }}
        />
      : <WorkspaceSecretDialog
          role={role}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          secret={modalPresence.value.kind === 'edit' ? modalPresence.value.secret : null}
          open={modalPresence.open}
          onOpenChangeComplete={modalPresence.onOpenChangeComplete}
          onClose={saved => {
            closeModal()
            if (saved) {
              onNotice(saved.notice)
              list.reload()
            }
          }}
        />)}
    {deleting && <DeleteWorkspaceSecretDialog workspaceId={workspaceId} secret={deleting} onClose={deleted => {
      setDeleting(null)
      if (deleted) list.reload()
    }} />}
  </>
}

function DeleteWorkspaceSecretDialog({ workspaceId, secret, onClose }: {
  workspaceId: string
  secret: WorkspaceSecretView
  onClose: (deleted: boolean) => void
}) {
  const t = useTranslations('Settings.secrets')
  const common = useTranslations('Common')
  const editor = useWorkspaceSecretEditor(workspaceId, secret, name => t('shortValueNotMasked', { name }))
  const busy = editor.pending === 'delete'
  return <AlertDialog open onOpenChange={open => { if (!open && !busy) onClose(false) }}>
    <AlertDialogContent aria-describedby={undefined}>
      <AlertDialogHeader><AlertDialogTitle>{t('removeTitle', { name: secret.name })}</AlertDialogTitle></AlertDialogHeader>
      {editor.error && <FieldError>{editor.error}</FieldError>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{common('cancel')}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" busy={busy} disabled={busy} onClick={event => {
          event.preventDefault()
          void editor.remove().then(ok => { if (ok) onClose(true) })
        }}>{common('delete')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

function PersonalSecretsAndLoginsCard({
  workspaceId,
  workspaceName,
  externalModal,
  onClearExternalModal,
  onNotice,
}: {
  workspaceId?: string
  workspaceName?: string
  externalModal: PersonalModalState | null
  onClearExternalModal: () => void
  onNotice: (message: string | null) => void
}) {
  const t = useTranslations('Settings.secrets')
  const tLogins = useTranslations('Settings.logins')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const locale = useLocale()
  const saved = useSavedLogins()
  const [localSecretModal, setLocalSecretModal] = useState<PersonalModalState | null>(null)
  const [deletingMySecret, setDeletingMySecret] = useState<UserSecretView | null>(null)
  const [loginModal, setLoginModal] = useState<LoginModalState | null>(null)
  const [removingLogin, setRemovingLogin] = useState<SavedLogin | null>(null)
  const [removingPending, setRemovingPending] = useState(false)
  const [usageOf, setUsageOf] = useState<SavedLogin | null>(null)

  const activeSecretModal = externalModal ?? localSecretModal
  const secretPresence = usePresence(activeSecretModal)
  const loginPresence = usePresence(loginModal)
  const closeSecretModal = () => {
    setLocalSecretModal(null)
    onClearExternalModal()
  }

  return <>
    <SettingsSection
      id="personal-secrets-logins"
      title={tp('personalSecretsAndLoginsHeading')}
      action={<DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={tp('addPersonalItem')} />}><Plus /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuGroup>
            {workspaceId && <DropdownMenuItem onClick={() => { onNotice(null); setLocalSecretModal({ kind: 'new' }) }}>{t('addMineTitle')}</DropdownMenuItem>}
            {workspaceId && <DropdownMenuItem onClick={() => { onNotice(null); setLocalSecretModal({ kind: 'bulk' }) }}>{tp('bulkImportEnv')}</DropdownMenuItem>}
            {workspaceId && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => setLoginModal({ kind: 'new' })}>{tLogins('addTitle')}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    >
      {workspaceId && <PersonalSecretRows
        workspaceId={workspaceId}
        hasLogins={saved.logins.length > 0}
        loginsLoading={saved.loading}
        onEdit={secret => { onNotice(null); setLocalSecretModal({ kind: 'edit', secret }) }}
        onDelete={setDeletingMySecret}
      />}
      {saved.loading && <SettingsLoading label={tLogins('loading')} rows={1} bare />}
      {saved.failed && <SettingsSaveError message={tLogins('loadError')} retryLabel={common('retry')} onRetry={() => { void saved.reload() }} />}
      {!workspaceId && !saved.loading && !saved.failed && saved.logins.length === 0 && <div className="flex items-center justify-between gap-3 px-4 py-4">
        <span className="text-sm text-muted-foreground">{tLogins('empty')}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setLoginModal({ kind: 'new' })}><Plus data-icon="inline-start" />{tLogins('add')}</Button>
      </div>}
      {saved.logins.map(login => {
        const usedInfo = login.lastUsedAt
          ? tLogins('lastUsedBy', { when: relativeTime(login.lastUsedAt, locale), bot: login.lastUsedBy ?? tLogins('unknownBot') })
          : null
        const subtitle = [tLogins('heading'), tp('onlyMeScope'), usedInfo].filter(Boolean).join(' · ')
        return <div key={login.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <SiteIcon origin={login.site} className="size-4 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground">{`${withoutScheme(login.site)} · ${login.account}`}</span>
              <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge className="bg-success/15 text-success-foreground">{tp('loginEnabled')}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={tLogins('actions', { site: withoutScheme(login.site) })} />}><Ellipsis /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => setLoginModal({ kind: 'password', login })}>{tLogins('changePassword')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setUsageOf(login)}>{tLogins('usage')}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => { saved.clearDeleteError(); setRemovingLogin(login) }}>{tLogins('delete')}</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      })}
      {saved.deleteError && <FieldError className="px-4 py-3">{saved.deleteError}</FieldError>}
    </SettingsSection>

    {workspaceId && secretPresence.value && (secretPresence.value.kind === 'bulk'
      ? <PersonalBulkDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          open={secretPresence.open}
          onOpenChangeComplete={secretPresence.onOpenChangeComplete}
          onClose={savedNotice => {
            closeSecretModal()
            if (savedNotice) onNotice(savedNotice.notice)
          }}
        />
      : <PersonalSecretDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          secret={secretPresence.value.kind === 'edit' ? secretPresence.value.secret : null}
          open={secretPresence.open}
          onOpenChangeComplete={secretPresence.onOpenChangeComplete}
          onClose={savedNotice => {
            closeSecretModal()
            if (savedNotice) onNotice(savedNotice.notice)
          }}
        />)}

    {workspaceId && deletingMySecret && <DeletePersonalSecretDialog workspaceId={workspaceId} secret={deletingMySecret} onClose={() => setDeletingMySecret(null)} />}

    {loginPresence.value && <SavedLoginDialog editing={loginPresence.value} open={loginPresence.open} onOpenChangeComplete={loginPresence.onOpenChangeComplete} onClose={done => {
      setLoginModal(null)
      if (done) void saved.reload()
    }} />}

    <AlertDialog open={removingLogin !== null} onOpenChange={open => { if (!open && !removingPending) setRemovingLogin(null) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{tLogins('deleteTitle', { site: removingLogin ? withoutScheme(removingLogin.site) : '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removingPending}>{tLogins('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" busy={removingPending} disabled={removingPending} onClick={event => {
            event.preventDefault()
            if (!removingLogin) return
            const target = removingLogin
            setRemovingPending(true)
            void saved.remove(target).finally(() => {
              setRemovingPending(false)
              setRemovingLogin(null)
            })
          }}>{tLogins('delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog open={usageOf !== null} onOpenChange={open => { if (!open) setUsageOf(null) }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{tLogins('usageTitle', { site: usageOf ? withoutScheme(usageOf.site) : '' })}</DialogTitle></DialogHeader>
        {usageOf && <SavedLoginUsageList id={usageOf.id} />}
      </DialogContent>
    </Dialog>
  </>
}

function PersonalSecretRows({
  workspaceId,
  hasLogins,
  loginsLoading,
  onEdit,
  onDelete,
}: {
  workspaceId: string
  hasLogins: boolean
  loginsLoading: boolean
  onEdit: (secret: UserSecretView) => void
  onDelete: (secret: UserSecretView) => void
}) {
  const t = useTranslations('Settings.secrets')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const locale = useLocale()
  const my = useMySecrets(workspaceId)

  if (my.loading) return <SettingsLoading label={t('loading')} rows={1} bare />
  if (my.error) return <SettingsSaveError message={my.error} retryLabel={common('retry')} onRetry={my.reload} />
  const secrets = my.secrets ?? []
  if (secrets.length === 0 && !hasLogins && !loginsLoading) {
    return <p className="px-4 py-4 text-sm text-muted-foreground">{tp('personalSecretsAndLoginsEmpty')}</p>
  }
  return <>
    {secrets.map(secret => {
      const subtitle = [tp('personalSecretScope'), tp('secretUpdatedAgo', { when: relativeTime(secret.updatedAt, locale) }), secret.note].filter(Boolean).join(' · ')
      return <div key={secret.id} className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-mono text-sm font-medium text-foreground">{secret.name}</span>
              {secret.kind === 'secret'
                ? <span aria-label={t('masked')} className="font-mono text-xs tracking-widest text-muted-foreground">••••••••</span>
                : <Badge variant="outline">{t('notMasked')}</Badge>}
            </div>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className="bg-success/15 text-success-foreground">{tp('secretConfigured')}</Badge>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('actions', { name: secret.name })} />}><Ellipsis /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => onEdit(secret)}>{t('edit')}</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(secret)}>{common('delete')}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    })}
  </>
}

function DeletePersonalSecretDialog({ workspaceId, secret, onClose }: {
  workspaceId: string
  secret: UserSecretView
  onClose: () => void
}) {
  const t = useTranslations('Settings.secrets')
  const common = useTranslations('Common')
  const my = useMySecrets(workspaceId)
  const editor = useMySecretEditor(workspaceId, secret, name => t('shortValueNotMasked', { name }))
  const busy = editor.pending === 'delete'
  return <AlertDialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <AlertDialogContent aria-describedby={undefined}>
      <AlertDialogHeader><AlertDialogTitle>{t('removeTitle', { name: secret.name })}</AlertDialogTitle></AlertDialogHeader>
      {editor.error && <FieldError>{editor.error}</FieldError>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{common('cancel')}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" busy={busy} disabled={busy} onClick={event => {
          event.preventDefault()
          void editor.remove().then(ok => {
            if (ok) {
              my.reload()
              onClose()
            }
          })
        }}>{common('delete')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

function ScopePickerFields({ role, scope, onScope, repository, onRepository, disabled, workspaceName }: {
  role: WorkspaceRole
  scope: SecretScope
  onScope: (next: SecretScope) => void
  repository: string
  onRepository: (next: string) => void
  disabled: boolean
  workspaceName?: string
}) {
  const t = useTranslations('Settings.secrets')
  const scopes = writableScopes(role)
  const scopeOptions = scopes.map(value => ({
    value,
    label: value === 'workspace' ? (workspaceName ?? t('workspaceGroup')) : t('repository'),
  }))
  return <FieldGroup>
    {scopes.length > 1 && <Field>
      <FieldLabel>{t('scope')}</FieldLabel>
      <SettingSelect fluid label={t('scope')} value={scope} options={scopeOptions} disabled={disabled} onValueChange={next => {
        if (next === 'workspace' || next === 'repository') onScope(next)
      }} />
    </Field>}
    {scope === 'repository' && <Field>
      <FieldLabel htmlFor="secret-repository">{t('repository')}</FieldLabel>
      <Input id="secret-repository" value={repository} placeholder="owner/repo" autoComplete="off" spellCheck={false} className="border-border bg-background font-mono" disabled={disabled} onChange={event => onRepository(event.target.value)} />
    </Field>}
  </FieldGroup>
}

function WorkspaceSecretDialog({ workspaceId, workspaceName, role, secret, onClose, open = true, onOpenChangeComplete }: {
  workspaceId: string
  workspaceName?: string
  role: WorkspaceRole
  secret: WorkspaceSecretView | null
  onClose: (saved: { notice: string | null } | null) => void
} & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const card = useTranslations('CredentialLogin')
  const [name, setName] = useState(secret?.name ?? '')
  const [kind, setKind] = useState<SecretKindChoice>(secret?.kind ?? 'secret')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [note, setNote] = useState(secret?.note ?? '')
  const [scope, setScope] = useState<SecretScope>(secret && secret.scopeType !== 'thread' ? secret.scopeType : writableScopes(role)[0])
  const [repository, setRepository] = useState(secret?.scopeRef ?? '')
  const [confirmWorkspace, setConfirmWorkspace] = useState(false)
  const editor = useWorkspaceSecretEditor(workspaceId, secret, secretName => t('shortValueNotMasked', { name: secretName }))
  const { pending, error, setError } = editor

  const moved = secret !== null && (scope !== secret.scopeType || (scope === 'repository' && repository.trim().toLowerCase() !== secret.scopeRef))
  const changed = secret === null || Boolean(value) || note.trim() !== secret.note || moved
  const scopeValid = scope === 'workspace' || SECRET_REPOSITORY.test(repository.trim())
  const ready = changed && scopeValid && (secret !== null ? (!moved || Boolean(value)) : Boolean(name.trim()) && Boolean(value))
  const kindOptions = [
    { value: 'secret', label: tp('secretKindMasked') },
    { value: 'env', label: tp('secretKindPlain') },
  ] as const

  async function persist() {
    setConfirmWorkspace(false)
    if (!secret) {
      const parsed = secretCreateValidator.safeParse({ name, kind, value, note })
      if (!parsed.success) {
        setError(tp('secretFormInvalid'))
        return
      }
    }
    const saved = await editor.save({ name, value, note, masked: kind === 'secret', scope, repository, moved })
    if (saved) onClose(saved)
  }

  function handleSubmit() {
    if (!ready || pending) return
    if (!secret) {
      const parsed = secretCreateValidator.safeParse({ name, kind, value, note })
      if (!parsed.success) {
        setError(tp('secretFormInvalid'))
        return
      }
    }
    if (scope === 'workspace' && (!secret || moved)) {
      setConfirmWorkspace(true)
      return
    }
    void persist()
  }

  return <>
    <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle className={cn(secret && 'font-mono')}>{secret ? secret.name : t('addTitle')}</DialogTitle></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); handleSubmit() }} autoComplete="off" className="flex flex-col gap-4">
          <FieldGroup>
            <ScopePickerFields role={role} scope={scope} onScope={setScope} repository={repository} onRepository={setRepository} disabled={pending !== null} workspaceName={workspaceName} />
            {!secret && <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="ws-secret-name">{t('name')}</FieldLabel>
                <Input id="ws-secret-name" value={name} maxLength={128} autoComplete="off" spellCheck={false} placeholder="OPENAI_API_KEY" className="border-border bg-background font-mono" disabled={pending !== null} onChange={event => { setName(event.target.value); setError(null) }} />
              </Field>
              <Field>
                <FieldLabel>{tp('secretKindLabel')}</FieldLabel>
                <SettingSelect fluid label={tp('secretKindLabel')} value={kind} options={kindOptions} disabled={pending !== null} onValueChange={next => {
                  if (next === 'secret' || next === 'env') setKind(next)
                }} />
              </Field>
            </div>}
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="ws-secret-value">{secret ? t('newValue') : t('value')}</FieldLabel>
              <InputGroup className="border-border bg-background">
                <InputGroupInput id="ws-secret-value" type={reveal ? 'text' : 'password'} value={value} autoComplete="new-password" spellCheck={false} aria-invalid={error ? true : undefined} disabled={pending !== null} onChange={event => { setValue(event.target.value); setError(null) }} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label={reveal ? card('hidePassword') : card('showPassword')} aria-pressed={reveal} onClick={() => setReveal(on => !on)}>{reveal ? <EyeOff /> : <Eye />}</InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="ws-secret-note">{t('note')}</FieldLabel>
              <Textarea id="ws-secret-note" value={note} maxLength={SECRET_NOTE_MAX} rows={2} disabled={pending !== null} onChange={event => setNote(event.target.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending !== null} onClick={() => onClose(null)}>{common('cancel')}</Button>
            <Button type="submit" busy={pending === 'save'} disabled={pending !== null || !ready}>{pending === 'save' ? common('saving') : common('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmWorkspace} onOpenChange={next => { if (!next && !pending) setConfirmWorkspace(false) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('confirmWorkspace', { workspace: workspaceName ?? t('workspaceGroup'), name: secret?.name ?? name.trim() })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending !== null}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="default" busy={pending === 'save'} disabled={pending !== null} onClick={event => { event.preventDefault(); void persist() }}>{common('save')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function PersonalSecretDialog({ workspaceId, workspaceName, secret, onClose, open = true, onOpenChangeComplete }: {
  workspaceId: string
  workspaceName?: string
  secret: UserSecretView | null
  onClose: (saved: { notice: string | null } | null) => void
} & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const card = useTranslations('CredentialLogin')
  const my = useMySecrets(workspaceId)
  const [name, setName] = useState(secret?.name ?? '')
  const [kind, setKind] = useState<SecretKindChoice>(secret?.kind ?? 'secret')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [note, setNote] = useState(secret?.note ?? '')
  const editor = useMySecretEditor(workspaceId, secret, secretName => t('shortValueNotMasked', { name: secretName }))
  const { pending, error, setError, shadow, cancelShadow } = editor

  const changed = secret === null || Boolean(value) || note.trim() !== secret.note
  const ready = changed && (secret !== null || (Boolean(name.trim()) && Boolean(value)))
  const kindOptions = [
    { value: 'secret', label: tp('secretKindMasked') },
    { value: 'env', label: tp('secretKindPlain') },
  ] as const

  async function submit(overrideWorkspace = false) {
    if (!secret) {
      const parsed = secretCreateValidator.safeParse({ name, kind, value, note })
      if (!parsed.success) {
        setError(tp('secretFormInvalid'))
        return
      }
    }
    const saved = await editor.save({ name, value, note, masked: kind === 'secret' }, overrideWorkspace)
    if (saved) {
      my.reload()
      onClose(saved)
    }
  }

  return <>
    <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle className={cn(secret && 'font-mono')}>{secret ? secret.name : t('addMineTitle')}</DialogTitle></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); if (ready && !pending) void submit() }} autoComplete="off" className="flex flex-col gap-4">
          <FieldGroup>
            {!secret && <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="my-secret-name">{t('name')}</FieldLabel>
                <Input id="my-secret-name" value={name} maxLength={128} autoComplete="off" spellCheck={false} placeholder="OPENAI_API_KEY" className="border-border bg-background font-mono" disabled={pending !== null} onChange={event => { setName(event.target.value); setError(null) }} />
              </Field>
              <Field>
                <FieldLabel>{tp('secretKindLabel')}</FieldLabel>
                <SettingSelect fluid label={tp('secretKindLabel')} value={kind} options={kindOptions} disabled={pending !== null} onValueChange={next => {
                  if (next === 'secret' || next === 'env') setKind(next)
                }} />
              </Field>
            </div>}
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="my-secret-value">{secret ? t('newValue') : t('value')}</FieldLabel>
              <InputGroup className="border-border bg-background">
                <InputGroupInput id="my-secret-value" type={reveal ? 'text' : 'password'} value={value} autoComplete="new-password" spellCheck={false} aria-invalid={error ? true : undefined} disabled={pending !== null} onChange={event => { setValue(event.target.value); setError(null) }} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label={reveal ? card('hidePassword') : card('showPassword')} aria-pressed={reveal} onClick={() => setReveal(on => !on)}>{reveal ? <EyeOff /> : <Eye />}</InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="my-secret-note">{t('note')}</FieldLabel>
              <Textarea id="my-secret-note" value={note} maxLength={SECRET_NOTE_MAX} rows={2} disabled={pending !== null} onChange={event => setNote(event.target.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending !== null} onClick={() => onClose(null)}>{common('cancel')}</Button>
            <Button type="submit" busy={pending === 'save'} disabled={pending !== null || !ready}>{pending === 'save' ? common('saving') : common('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={shadow} onOpenChange={next => { if (!next && !pending) cancelShadow() }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('shadowConfirm', { workspace: workspaceName ?? t('workspaceGroup'), name: name.trim() })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending !== null}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="default" busy={pending === 'save'} disabled={pending !== null} onClick={event => { event.preventDefault(); void submit(true) }}>{t('useMine')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function WorkspaceBulkDialog({ workspaceId, workspaceName, role, onClose, open = true, onOpenChangeComplete }: {
  workspaceId: string
  workspaceName?: string
  role: WorkspaceRole
  onClose: (saved: { notice: string | null } | null) => void
} & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const actionError = useActionError()
  const [text, setText] = useState('')
  const [masked, setMasked] = useState(true)
  const [onConflict, setOnConflict] = useState<ConflictStrategy>('replace')
  const [scope, setScope] = useState<SecretScope>(writableScopes(role)[0])
  const [repository, setRepository] = useState('')
  const [confirm, setConfirm] = useState(false)
  const importer = useWorkspaceSecretImport(workspaceId)
  const { pending, error, setError } = importer
  const { preview, count } = useDotenvPreview(text)
  const ready = count > 0 && (scope === 'workspace' || SECRET_REPOSITORY.test(repository.trim()))
  const readFile = useDotenvFile(setText)
  const fileInput = useRef<HTMLInputElement>(null)
  const conflictOptions = [
    { value: 'replace', label: t('replaceExisting') },
    { value: 'skip', label: tp('skipExisting') },
  ] as const

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setError(readFile(file))
  }

  async function save() {
    setConfirm(false)
    const parsed = dotenvImportValidator.safeParse({ text, masked, scope, onConflict })
    if (!parsed.success) return
    const total = await importer.run({ text: parsed.data.text, masked: parsed.data.masked, replace: parsed.data.onConflict === 'replace', scope: parsed.data.scope, repository })
    if (!total) return
    setText('')
    onClose({ notice: t('importDone', total) })
  }

  return <>
    <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{tp('bulkImportEnv')}</DialogTitle></DialogHeader>
        <form onSubmit={event => {
          event.preventDefault()
          if (!ready || pending) return
          if (scope === 'workspace') setConfirm(true)
          else void save()
        }} autoComplete="off" className="flex flex-col gap-4">
          <FieldGroup>
            <ScopePickerFields role={role} scope={scope} onScope={setScope} repository={repository} onRepository={setRepository} disabled={pending} workspaceName={workspaceName} />
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="ws-secret-dotenv">{t('paste')}</FieldLabel>
              <Textarea id="ws-secret-dotenv" value={text} rows={6} spellCheck={false} autoComplete="off" className="font-mono text-xs [-webkit-text-security:disc]" placeholder="KEY=value # note" aria-invalid={error ? true : undefined} disabled={pending} onChange={event => { setText(event.target.value); setError(null) }} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Field>
              <Input ref={fileInput} type="file" accept=".env,text/plain" className="hidden" tabIndex={-1} aria-hidden="true" disabled={pending} onChange={pick} />
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => fileInput.current?.click()}><FileUp data-icon="inline-start" />{t('pickFile')}</Button>
                <FieldDescription>{t('pickFileLimit')}</FieldDescription>
              </div>
            </Field>
            {preview && ('tooLarge' in preview
              ? <FieldError>{actionError('secretImportTooLarge')}</FieldError>
              : <div role="status" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('willAdd', { count })}</span>
                <ul className="flex max-h-36 flex-col gap-0.5 overflow-y-auto">
                  {preview.entries.map(entry => <li key={entry.line} className="truncate font-mono text-xs">{entry.name}</li>)}
                  {preview.errors.map(problem => <li key={`e${problem.line}`} className="text-xs text-destructive-foreground">{t(`lineError.${problem.reason}`, { line: problem.line, name: 'name' in problem ? problem.name ?? '' : '' })}</li>)}
                </ul>
              </div>)}
            <Field orientation="horizontal" className="justify-between">
              <FieldLabel htmlFor="ws-bulk-masked">{t('masked')}</FieldLabel>
              <Switch id="ws-bulk-masked" checked={masked} disabled={pending} onCheckedChange={setMasked} />
            </Field>
            <Field orientation="horizontal" className="justify-between">
              <FieldLabel>{tp('conflictLabel')}</FieldLabel>
              <SettingSelect fluid label={tp('conflictLabel')} value={onConflict} options={conflictOptions} disabled={pending} onValueChange={next => {
                if (next === 'replace' || next === 'skip') setOnConflict(next)
              }} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(null)}>{common('cancel')}</Button>
            <Button type="submit" busy={pending} disabled={pending || !ready}>{t('addCount', { count })}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirm} onOpenChange={next => { if (!next && !pending) setConfirm(false) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('confirmWorkspaceMany', { workspace: workspaceName ?? t('workspaceGroup'), count })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="default" busy={pending} disabled={pending} onClick={event => { event.preventDefault(); void save() }}>{t('addCount', { count })}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function PersonalBulkDialog({ workspaceId, workspaceName, onClose, open = true, onOpenChangeComplete }: {
  workspaceId: string
  workspaceName?: string
  onClose: (saved: { notice: string | null } | null) => void
} & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const tp = useTranslations('Settings.polish')
  const common = useTranslations('Common')
  const actionError = useActionError()
  const my = useMySecrets(workspaceId)
  const [text, setText] = useState('')
  const [masked, setMasked] = useState(true)
  const [onConflict, setOnConflict] = useState<ConflictStrategy>('replace')
  const importer = useMySecretImport(workspaceId)
  const { pending, error, setError, shadowed, cancelShadow } = importer
  const { preview, count } = useDotenvPreview(text)
  const ready = count > 0
  const readFile = useDotenvFile(setText)
  const fileInput = useRef<HTMLInputElement>(null)
  const conflictOptions = [
    { value: 'replace', label: t('replaceExisting') },
    { value: 'skip', label: tp('skipExisting') },
  ] as const

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setError(readFile(file))
  }

  async function save(overrideWorkspace = false) {
    const parsed = dotenvImportValidator.safeParse({ text, masked, scope: 'workspace', onConflict })
    if (!parsed.success) return
    const total = await importer.run({ text: parsed.data.text, masked: parsed.data.masked, replace: parsed.data.onConflict === 'replace' }, overrideWorkspace)
    if (!total) return
    setText('')
    my.reload()
    onClose({ notice: t('importDone', total) })
  }

  return <>
    <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{tp('bulkImportEnv')}</DialogTitle></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); if (ready && !pending) void save() }} autoComplete="off" className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="my-secret-dotenv">{t('paste')}</FieldLabel>
              <Textarea id="my-secret-dotenv" value={text} rows={6} spellCheck={false} autoComplete="off" className="font-mono text-xs [-webkit-text-security:disc]" placeholder="KEY=value # note" aria-invalid={error ? true : undefined} disabled={pending} onChange={event => { setText(event.target.value); setError(null) }} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Field>
              <Input ref={fileInput} type="file" accept=".env,text/plain" className="hidden" tabIndex={-1} aria-hidden="true" disabled={pending} onChange={pick} />
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => fileInput.current?.click()}><FileUp data-icon="inline-start" />{t('pickFile')}</Button>
                <FieldDescription>{t('pickFileLimit')}</FieldDescription>
              </div>
            </Field>
            {preview && ('tooLarge' in preview
              ? <FieldError>{actionError('secretImportTooLarge')}</FieldError>
              : <div role="status" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('willAdd', { count })}</span>
                <ul className="flex max-h-36 flex-col gap-0.5 overflow-y-auto">
                  {preview.entries.map(entry => <li key={entry.line} className="truncate font-mono text-xs">{entry.name}</li>)}
                  {preview.errors.map(problem => <li key={`e${problem.line}`} className="text-xs text-destructive-foreground">{t(`lineError.${problem.reason}`, { line: problem.line, name: 'name' in problem ? problem.name ?? '' : '' })}</li>)}
                </ul>
              </div>)}
            <Field orientation="horizontal" className="justify-between">
              <FieldLabel htmlFor="my-bulk-masked">{t('masked')}</FieldLabel>
              <Switch id="my-bulk-masked" checked={masked} disabled={pending} onCheckedChange={setMasked} />
            </Field>
            <Field orientation="horizontal" className="justify-between">
              <FieldLabel>{tp('conflictLabel')}</FieldLabel>
              <SettingSelect fluid label={tp('conflictLabel')} value={onConflict} options={conflictOptions} disabled={pending} onValueChange={next => {
                if (next === 'replace' || next === 'skip') setOnConflict(next)
              }} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(null)}>{common('cancel')}</Button>
            <Button type="submit" busy={pending} disabled={pending || !ready}>{t('addCount', { count })}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={shadowed !== null} onOpenChange={next => { if (!next && !pending) cancelShadow() }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('shadowConfirmMany', { workspace: workspaceName ?? t('workspaceGroup'), names: shadowed?.join('、') ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="default" busy={pending} disabled={pending} onClick={event => { event.preventDefault(); void save(true) }}>{t('useMine')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function SavedLoginDialog({ editing, open, onOpenChangeComplete, onClose }: {
  editing: LoginModalState
  open: boolean
  onOpenChangeComplete: (open: boolean) => void
  onClose: (saved: boolean) => void
}) {
  const t = useTranslations('Settings.logins')
  const card = useTranslations('CredentialLogin')
  const login = editing.kind === 'password' ? editing.login : null
  const [site, setSite] = useState(login?.site ?? '')
  const [account, setAccount] = useState(login?.account ?? '')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const { pending, error, setError, save } = useSavedLoginEditor(login)
  const ready = Boolean(password) && (login !== null || (Boolean(site.trim()) && Boolean(account.trim())))

  async function submit() {
    if (!ready || pending) return
    if (!login) {
      const parsed = savedLoginValidator.safeParse({ site, account, password })
      if (!parsed.success) return
    }
    if (!await save({ site, account, password })) return
    setPassword('')
    onClose(true)
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(false) }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{login ? withoutScheme(login.site) : t('addTitle')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void submit() }} autoComplete="off" className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="vault-login-site">{t('site')}</FieldLabel>
            <Input id="vault-login-site" value={site} readOnly={login !== null} className={cn('border-border bg-background', login && 'text-muted-foreground')} autoComplete="off" spellCheck={false} inputMode="url" placeholder="https://" disabled={pending} onChange={event => setSite(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="vault-login-account">{t('account')}</FieldLabel>
            <Input id="vault-login-account" value={account} readOnly={login !== null} className={cn('border-border bg-background', login && 'text-muted-foreground')} autoComplete="off" spellCheck={false} disabled={pending} onChange={event => setAccount(event.target.value)} />
          </Field>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="vault-login-password">{login ? t('newPassword') : t('password')}</FieldLabel>
            <InputGroup className="border-border bg-background">
              <InputGroupInput id="vault-login-password" type={reveal ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} aria-invalid={error ? true : undefined} value={password} disabled={pending} onChange={event => { setPassword(event.target.value); setError(null) }} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={reveal ? card('hidePassword') : card('showPassword')} aria-pressed={reveal} onClick={() => setReveal(val => !val)}>{reveal ? <EyeOff /> : <Eye />}</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && <FieldError>{error}</FieldError>}
          </Field>
        </FieldGroup>
        <DialogFooter className="sm:justify-between">
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" />{card('securedBy')}<MikkaMarkSmall />Mikka</span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(false)}>{t('cancel')}</Button>
            <Button type="submit" busy={pending} disabled={pending || !ready}>{t('save')}</Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function SavedLoginUsageList({ id }: { id: string }) {
  const t = useTranslations('Settings.logins')
  const common = useTranslations('Common')
  const locale = useLocale()
  const { uses, loading, failed, reload } = useSavedLoginUsage(id)
  if (loading) return <SettingsLoading label={t('usageLoading')} rows={2} bare />
  if (failed) return <SettingsSaveError message={t('usageError')} retryLabel={common('retry')} onRetry={() => { void reload() }} />
  if (uses.length === 0) return <p className="text-sm text-muted-foreground">{t('usageEmpty')}</p>
  return <div className="flex max-h-80 flex-col divide-y divide-border overflow-auto">
    {uses.map(use => <div key={use.id} className="flex flex-col gap-0.5 py-2.5">
      <span className="text-sm">{use.botName ?? t('unknownBot')} · {t(`result.${use.result}`)}</span>
      <span className="text-xs text-muted-foreground">{relativeTime(use.at, locale)}</span>
    </div>)}
  </div>
}
