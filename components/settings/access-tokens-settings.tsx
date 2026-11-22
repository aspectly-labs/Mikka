'use client'

import { useState } from 'react'
import { z } from 'zod'
import useSWR from 'swr'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { Check, Copy, Plus } from '@/components/icons'
import { createAccessToken, listAccessTokens, revokeAccessToken } from '@/app/actions/tokens'
import { ServiceIdentityRequestError, serviceIdentityClient, type ServiceIdentityPage, type ServiceIdentityRow } from '@/lib/governance/service-identity-client'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection, settingsSelectTriggerClass } from '@/components/settings/primitives'
import { settingsReadOptions } from '@/lib/settings-data'
import { settingsKeys } from '@/lib/swr/keys'
import type { PersonalAccessTokenView } from '@/lib/tokens/store'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { cn } from '@/lib/utils'

const EXPIRY_DAYS = { '30': 30, '90': 90, '365': 365, never: null } as const
type Expiry = keyof typeof EXPIRY_DAYS

const patFormSchema = z.object({
  name: z.string().trim().min(1).max(64),
  expiry: z.enum(['30', '90', '365', 'never']),
})

const serviceAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

/** API (frames 14 & 32): workspace service accounts and personal API keys. */
export function AccessTokensSettings({ workspaceId }: { workspaceId?: string }) {
  const t = useTranslations('Settings.tokens')
  const tp = useTranslations('Settings.polish')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const actionError = useActionError()
  const tokens = useSWR(settingsKeys.tokens(workspaceId), () => listAccessTokens(workspaceId), settingsReadOptions)
  const [creating, setCreating] = useState(false)
  const createDialog = usePresence(creating)
  const [revoking, setRevoking] = useState<PersonalAccessTokenView | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rows = tokens.data && !tokens.data.error ? tokens.data : null
  const date = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })

  function describe(token: PersonalAccessTokenView) {
    const used = token.lastUsedAt ? t('lastUsed', { when: relativeTime(token.lastUsedAt, locale) }) : t('neverUsed')
    const expiry = token.expired ? t('expired') : token.expiresAt ? t('expires', { date: date.format(new Date(token.expiresAt)) }) : t('noExpiry')
    return `mkp_…${token.hint} · ${used} · ${expiry}`
  }

  async function revoke(token: PersonalAccessTokenView) {
    setPending(true)
    setError(null)
    try {
      const result = await revokeAccessToken({ id: token.id }, workspaceId)
      if (result.error) setError(actionError(result.error))
      await tokens.mutate()
    } catch {
      setError(actionError())
    } finally {
      setPending(false)
      setRevoking(null)
    }
  }

  return <>
    <p className="-mt-4 text-xs text-muted-foreground">{tp('apiLead')}</p>
    {workspaceId && <ServiceAccountsSection workspaceId={workspaceId} />}
    <SettingsSection id="tokens-heading" title={tp('apiKeysHeading')} description={tp('apiKeysDescription')}>
      {!tokens.data && !tokens.error && <SettingsLoading label={t('loading')} rows={2} bare />}
      {(tokens.error || tokens.data?.error) && <SettingsSaveError message={actionError(tokens.data?.error)} retryLabel={commonT('retry')} onRetry={() => { void tokens.mutate() }} />}
      {rows?.length === 0 && <SettingRow title={tp('apiKeysEmpty')}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={tp('createApiKey')} onClick={() => setCreating(true)}><Plus /></Button>
      </SettingRow>}
      {rows && rows.length > 0 && <>
        <SettingRow title={tp('personalKeysRow')}>
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>{tp('createApiKey')}</Button>
        </SettingRow>
        {rows.map(token => <SettingRow key={token.id} title={token.name} description={describe(token)}>
          <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => setRevoking(token)}>{t('revoke')}</Button>
        </SettingRow>)}
      </>}
    </SettingsSection>
    {error && <FieldError className="px-1">{error}</FieldError>}
    {createDialog.value && <CreateTokenDialog open={createDialog.open} onOpenChangeComplete={createDialog.onOpenChangeComplete} workspaceId={workspaceId} onDone={() => { setCreating(false); void tokens.mutate() }} />}
    <AlertDialog open={revoking !== null} onOpenChange={open => { if (!open && !pending) setRevoking(null) }}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogHeader><AlertDialogTitle>{t('revokeTitle', { name: revoking?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" busy={pending} disabled={pending} onClick={event => { event.preventDefault(); if (revoking) void revoke(revoking) }}>{t('revoke')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function ServiceAccountsSection({ workspaceId }: { workspaceId: string }) {
  const tp = useTranslations('Settings.polish')
  const tsi = useTranslations('ServiceIdentities')
  const commonT = useTranslations('Common')
  const list = useSWR<ServiceIdentityPage>(
    ['settings:service-identities', workspaceId],
    () => serviceIdentityClient(workspaceId).list(),
    { ...settingsReadOptions, shouldRetryOnError: false },
  )
  const [extra, setExtra] = useState<ServiceIdentityRow[]>([])
  const [cursor, setCursor] = useState<string | null | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState<ServiceIdentityRow | null>(null)
  const createDialog = usePresence(creating)
  const manageDialog = usePresence(managing)

  const err = list.error instanceof ServiceIdentityRequestError ? list.error : null
  const personalOnly = err?.status === 400 && err.detail === 'personal_workspace'
  const adminOnly = err?.status === 403
  const otherError = Boolean(list.error) && !personalOnly && !adminOnly
  const baseRows = list.data?.identities ?? []
  const merged = [...baseRows, ...extra.filter(item => !baseRows.some(base => base.id === item.id))]
  const nextCursor = cursor === undefined ? (list.data?.nextCursor ?? null) : cursor

  async function refresh() {
    setExtra([])
    setCursor(undefined)
    await list.mutate()
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await serviceIdentityClient(workspaceId).list(nextCursor)
      setExtra(current => [...current, ...page.identities])
      setCursor(page.nextCursor)
    } catch {
      setCursor(null)
    } finally {
      setLoadingMore(false)
    }
  }

  return <>
    <SettingsSection id="service-accounts-heading" title={tp('serviceAccountsHeading')} description={tp('serviceAccountsDescription')}>
      {!list.data && !list.error && <SettingsLoading label={tsi('title')} rows={1} bare />}
      {personalOnly && <SettingRow title={tp('serviceAccountsEmpty')} description={tp('serviceAccountsTeamOnly')} />}
      {adminOnly && <SettingRow title={tp('serviceAccountsHeading')} description={tp('serviceAccountsAdminOnly')} />}
      {otherError && <SettingsSaveError message={tsi('failed')} retryLabel={commonT('retry')} onRetry={() => { void refresh() }} />}
      {list.data && merged.length === 0 && <SettingRow title={tp('serviceAccountsEmpty')}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={tp('createServiceAccount')} onClick={() => setCreating(true)}><Plus /></Button>
      </SettingRow>}
      {list.data && merged.length > 0 && <>
        <SettingRow title={tp('serviceAccountsHeading')}>
          <Button type="button" size="sm" onClick={() => setCreating(true)}>{tp('createServiceAccount')}</Button>
        </SettingRow>
        {merged.map(identity => <SettingRow key={identity.id} title={identity.name} description={identity.enabled ? tsi('active') : tsi('disabled')}>
          <Button type="button" variant="outline" size="sm" aria-label={tsi('manage', { name: identity.name })} onClick={() => setManaging(identity)}>{tp('manage')}</Button>
        </SettingRow>)}
        {nextCursor && <SettingRow title={tsi('more')}>
          <Button type="button" variant="ghost" size="sm" busy={loadingMore} onClick={() => void loadMore()}>{tsi('more')}</Button>
        </SettingRow>}
      </>}
    </SettingsSection>
    {createDialog.value && <CreateServiceAccountDialog workspaceId={workspaceId} open={createDialog.open} onOpenChangeComplete={createDialog.onOpenChangeComplete} onClose={created => {
      setCreating(false)
      if (created) {
        void refresh()
        setManaging(created)
      }
    }} />}
    {manageDialog.value && <ManageServiceAccountDialog workspaceId={workspaceId} identity={manageDialog.value} open={manageDialog.open} onOpenChangeComplete={manageDialog.onOpenChangeComplete} onClose={changed => {
      setManaging(null)
      if (changed) void refresh()
    }} />}
  </>
}

function CreateServiceAccountDialog({ workspaceId, onClose, open = true, onOpenChangeComplete }: {
  workspaceId: string
  onClose: (created: ServiceIdentityRow | null) => void
} & PresenceProps) {
  const tp = useTranslations('Settings.polish')
  const tsi = useTranslations('ServiceIdentities')
  const commonT = useTranslations('Common')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId] = useState(() => crypto.randomUUID())

  async function submit() {
    const parsed = serviceAccountSchema.safeParse({ name })
    if (!parsed.success) {
      setError(tp('serviceAccountNameRequired'))
      return
    }
    setPending(true)
    setError(null)
    try {
      const created = await serviceIdentityClient(workspaceId).create(parsed.data.name, requestId)
      onClose(created)
    } catch (err) {
      const reqErr = err instanceof ServiceIdentityRequestError ? err : null
      setError(reqErr?.status === 403 ? tsi('denied') : reqErr?.status === 409 ? tsi('conflict') : tsi('failed'))
    } finally {
      setPending(false)
    }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{tp('createServiceAccount')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void submit() }} className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="service-account-name">{tsi('name')}</FieldLabel>
            <Input id="service-account-name" value={name} maxLength={100} autoFocus className="border-border bg-background" disabled={pending} onChange={event => { setName(event.target.value); setError(null) }} />
          </Field>
        </FieldGroup>
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(null)}>{commonT('cancel')}</Button>
          <Button type="submit" busy={pending} disabled={pending || !name.trim()}>{commonT('create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function ManageServiceAccountDialog({ workspaceId, identity, onClose, open = true, onOpenChangeComplete }: {
  workspaceId: string
  identity: ServiceIdentityRow
  onClose: (changed: boolean) => void
} & PresenceProps) {
  const t = useTranslations('Settings.tokens')
  const tp = useTranslations('Settings.polish')
  const tsi = useTranslations('ServiceIdentities')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const [row, setRow] = useState(identity)
  const [name, setName] = useState(identity.name)
  const [expiry, setExpiry] = useState<Expiry>('90')
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [pending, setPending] = useState<'rename' | 'toggle' | 'rotate' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const cred = useSWR(
    ['settings:service-identity-credential', workspaceId, row.id],
    () => serviceIdentityClient(workspaceId).credential(row.id),
    { ...settingsReadOptions, revalidateOnMount: true },
  )
  const expiryItems = (Object.keys(EXPIRY_DAYS) as Expiry[]).map(value => ({ value, label: t(`expiry.${value}`) }))
  const dateFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })

  function handleError(err: unknown) {
    const reqErr = err instanceof ServiceIdentityRequestError ? err : null
    setError(reqErr?.status === 403 ? tsi('denied') : reqErr?.status === 409 ? tsi('conflict') : tsi('failed'))
  }

  async function saveName() {
    const parsed = serviceAccountSchema.safeParse({ name })
    if (!parsed.success || parsed.data.name === row.name) return
    setPending('rename')
    setError(null)
    try {
      const updated = await serviceIdentityClient(workspaceId).change(row, { action: 'rename', name: parsed.data.name })
      setRow(updated)
      setName(updated.name)
      setDirty(true)
    } catch (err) {
      handleError(err)
    } finally {
      setPending(null)
    }
  }

  async function toggleEnabled() {
    setPending('toggle')
    setError(null)
    try {
      const updated = await serviceIdentityClient(workspaceId).change(row, { action: row.enabled ? 'disable' : 'restore' })
      setRow(updated)
      setDirty(true)
      await cred.mutate()
    } catch (err) {
      handleError(err)
    } finally {
      setPending(null)
    }
  }

  async function rotateKey() {
    if (!cred.data) return
    setPending('rotate')
    setError(null)
    try {
      const days = EXPIRY_DAYS[expiry]
      const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null
      const next = await serviceIdentityClient(workspaceId).rotate(row.id, cred.data.revision, expiresAt, cred.data.organizationId)
      setIssuedToken(next.token)
      setCopied(false)
      setCopyFailed(false)
      setDirty(true)
      await cred.mutate()
    } catch (err) {
      handleError(err)
    } finally {
      setPending(null)
    }
  }

  async function revokeKey() {
    if (!cred.data) return
    setPending('revoke')
    setError(null)
    try {
      await serviceIdentityClient(workspaceId).revoke(row.id, cred.data.revision)
      setIssuedToken(null)
      setDirty(true)
      await cred.mutate()
    } catch (err) {
      handleError(err)
    } finally {
      setPending(null)
    }
  }

  async function copyIssued() {
    if (!issuedToken || copying) return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(issuedToken)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopied(false)
      setCopyFailed(true)
    } finally {
      setCopying(false)
    }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(dirty) }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <DialogTitle>{row.name}</DialogTitle>
          <Badge variant={row.enabled ? 'secondary' : 'outline'}>{row.enabled ? tsi('active') : tsi('disabled')}</Badge>
        </div>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="manage-service-name">{tsi('name')}</FieldLabel>
            <div className="flex items-center gap-2">
              <Input id="manage-service-name" value={name} maxLength={100} className="border-border bg-background" disabled={pending !== null} onChange={event => setName(event.target.value)} />
              <Button type="button" variant="outline" busy={pending === 'rename'} disabled={pending !== null || !name.trim() || name.trim() === row.name} onClick={() => void saveName()}>{tsi('rename')}</Button>
            </div>
          </Field>
          <Field>
            <FieldLabel>{tsi('credential')}</FieldLabel>
            {cred.data ? <p className="text-xs text-muted-foreground">
              {cred.data.configured
                ? cred.data.expiresAt ? tsi('expires', { date: dateFmt.format(new Date(cred.data.expiresAt)) }) : tsi('configured')
                : tsi('unconfigured')}
            </p> : <p className="text-xs text-muted-foreground">{commonT('loading')}</p>}
            {row.enabled && cred.data && <div className="flex flex-wrap items-center gap-2">
              <Select value={expiry} items={expiryItems} onValueChange={value => { if (value) setExpiry(value as Expiry) }}>
                <SelectTrigger size="sm" aria-label={t('expiryLabel')} className={cn(settingsSelectTriggerClass, 'w-36')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{expiryItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" busy={pending === 'rotate'} disabled={pending !== null} onClick={() => void rotateKey()}>
                {cred.data.configured ? tsi('rotate') : tsi('issue')}
              </Button>
              {cred.data.configured && <Button type="button" variant="destructive" size="sm" busy={pending === 'revoke'} disabled={pending !== null} onClick={() => void revokeKey()}>
                {tsi('revoke')}
              </Button>}
            </div>}
          </Field>
        </FieldGroup>
        {issuedToken && <div className="flex flex-col gap-1.5 text-sm">
          <InputGroup className="border-border bg-background">
            <InputGroupInput aria-label={tsi('keyValue')} readOnly value={issuedToken} className="font-mono text-xs" onFocus={event => event.currentTarget.select()} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" busy={copying} aria-label={t('copy')} onClick={() => void copyIssued()}>{copied ? <Check /> : <Copy />}</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <p className="text-xs text-muted-foreground">{tsi('copyNow')}</p>
          {copyFailed && <FieldError role="alert">{t('copyFailed')}</FieldError>}
        </div>}
        {error && <FieldError>{error}</FieldError>}
      </div>
      <DialogFooter className="sm:justify-between">
        <Button type="button" variant={row.enabled ? 'destructive' : 'outline'} busy={pending === 'toggle'} disabled={pending !== null} onClick={() => void toggleEnabled()}>
          {row.enabled ? tsi('disable') : tsi('restore')}
        </Button>
        <Button type="button" onClick={() => onClose(dirty)}>{tp('close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function CreateTokenDialog({ workspaceId, onDone, open = true, onOpenChangeComplete }: { workspaceId?: string; onDone: () => void } & PresenceProps) {
  const t = useTranslations('Settings.tokens')
  const tp = useTranslations('Settings.polish')
  const actionError = useActionError()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<Expiry>('90')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const expiryItems = (Object.keys(EXPIRY_DAYS) as Expiry[]).map(value => ({ value, label: t(`expiry.${value}`) }))

  async function create() {
    const parsed = patFormSchema.safeParse({ name, expiry })
    if (!parsed.success) {
      setError(tp('tokenNameRequired'))
      return
    }
    setPending(true)
    setError(null)
    try {
      const days = EXPIRY_DAYS[parsed.data.expiry]
      const result = await createAccessToken({ name: parsed.data.name, expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      setToken(result.token)
    } catch {
      setError(actionError())
    } finally {
      setPending(false)
    }
  }

  async function copy() {
    if (!token || copying) return
    // This token is shown once. A silent failure leaves the person believing
    // they copied it, then pasting an empty clipboard; say it did not work and
    // leave the value selected so it can still be copied by hand. A later
    // success clears the warning, so the two states never show together.
    setCopying(true)
    try { await navigator.clipboard.writeText(token); setCopied(true); setCopyFailed(false) }
    catch { setCopied(false); setCopyFailed(true) }
    finally { setCopying(false) }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onDone() }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{token ? t('createdTitle', { name: name.trim() }) : tp('createApiKey')}</DialogTitle></DialogHeader>
      {token
        ? <div className="flex flex-col gap-2 text-sm">
          <InputGroup className="border-border bg-background">
            <InputGroupInput aria-label={t('token')} readOnly value={token} className="font-mono" onFocus={event => event.currentTarget.select()} />
            <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" busy={copying} aria-label={t('copy')} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</InputGroupButton></InputGroupAddon>
          </InputGroup>
          <p className="text-muted-foreground">{t('shownOnce')}</p>
          {copyFailed && <FieldError role="alert">{t('copyFailed')}</FieldError>}
        </div>
        : <form id="create-pat-form" onSubmit={event => { event.preventDefault(); void create() }} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="pat-name">{t('name')}</FieldLabel>
              <Input id="pat-name" value={name} maxLength={64} autoFocus className="border-border bg-background" disabled={pending} onChange={event => { setName(event.target.value); setError(null) }} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pat-expiry">{t('expiryLabel')}</FieldLabel>
              <Select value={expiry} items={expiryItems} disabled={pending} onValueChange={value => { if (value) setExpiry(value as Expiry) }}>
                <SelectTrigger id="pat-expiry" aria-label={t('expiryLabel')} className={cn(settingsSelectTriggerClass, 'w-full')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{expiryItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {error && <FieldError>{error}</FieldError>}
        </form>}
      <DialogFooter>
        {token
          ? <Button type="button" onClick={onDone}>{t('done')}</Button>
          : <>
            <Button type="button" variant="outline" disabled={pending} onClick={onDone}>{t('cancel')}</Button>
            <Button type="submit" form="create-pat-form" busy={pending} disabled={pending || !name.trim()}>{pending ? t('creating') : t('create')}</Button>
          </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
