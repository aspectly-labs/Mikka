'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from '@/components/icons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import {
  PASSKEY_NAME_MAX,
  usePasskeys,
  useTwoFactorSettings,
  type PasskeyErrorKind,
  type PasskeySummary,
} from '@/hooks/settings/use-passkeys'

function formatPasskeyDate(createdAt: string | null, locale: string): string | null {
  if (!createdAt) return null
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

function passkeyErrorMessage(t: ReturnType<typeof useTranslations<'Settings.passkeys'>>, kind: PasskeyErrorKind): string {
  switch (kind) {
    case 'twoFactorRequired': return t('errorTwoFactorRequired')
    case 'notFound': return t('errorNotFound')
    case 'invalidName': return t('errorInvalidName')
    case 'cancelled': return t('errorCancelled')
    case 'failed': return t('errorFailed')
  }
}

/**
 * Frame 04 `两步验证` section: TOTP enrollment, session verification, and recovery codes,
 * backed by `GET /api/me/security` and `/api/auth/two-factor/*`.
 */
export function TwoFactorSection({ hasPassword }: { hasPassword: boolean | null }) {
  const t = useTranslations('Settings.passkeys')
  const twoFactor = useTwoFactorSettings()
  const [passwordModal, setPasswordModal] = useState<'enable' | 'disable' | 'regenerate' | null>(null)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [codeDraft, setCodeDraft] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const enabled = twoFactor.state?.twoFactorEnabled === true
  const verified = twoFactor.state?.sessionVerified === true
  const needsPassword = hasPassword === true

  function copyValue(key: string, text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey(current => (current === key ? null : current)), 1500)
    }).catch(() => {})
  }

  function requestAction(kind: 'enable' | 'disable' | 'regenerate') {
    twoFactor.clearError()
    if (needsPassword) {
      setPasswordDraft('')
      setPasswordModal(kind)
      return
    }
    if (kind === 'enable') void twoFactor.startEnable().then(ok => { if (ok) setCodeDraft('') })
    if (kind === 'disable') void twoFactor.disable()
    if (kind === 'regenerate') void twoFactor.regenerateBackupCodes()
  }

  async function submitPasswordAction() {
    if (!passwordModal) return
    const action = passwordModal
    if (action === 'enable') {
      const ok = await twoFactor.startEnable(passwordDraft)
      if (ok) { setPasswordModal(null); setCodeDraft('') }
      return
    }
    if (action === 'disable') {
      const ok = await twoFactor.disable(passwordDraft)
      if (ok) setPasswordModal(null)
      return
    }
    const ok = await twoFactor.regenerateBackupCodes(passwordDraft)
    if (ok) setPasswordModal(null)
  }

  const errorText = twoFactor.error === 'invalidCode'
    ? t('twoFactorInvalidCode')
    : twoFactor.error === 'orgRequired'
      ? t('twoFactorOrgRequired')
      : twoFactor.error === 'twoFactorRequired'
        ? t('sessionUnverifiedHint')
        : twoFactor.error === 'failed'
          ? t('twoFactorActionFailed')
          : null

  return <>
    <SettingsSection id="two-factor-heading" title={t('twoFactorHeading')} description={t('twoFactorSubtitle')}>
      <SettingRow icon={<ShieldCheck className="size-4 text-muted-foreground" aria-hidden />} title={t('twoFactorRow')} description={t('twoFactorRowHint')}>
        <div className="flex items-center gap-2">
          {enabled && !verified && <Button type="button" variant="secondary" size="sm" onClick={() => { twoFactor.clearError(); setCodeDraft(''); setVerifyOpen(true) }}>
            {t('verifySession')}
          </Button>}
          <Switch
            aria-label={t('twoFactorRow')}
            checked={enabled}
            disabled={twoFactor.loading || twoFactor.pending !== null || (enabled && twoFactor.orgRequiresTwoFactor)}
            onCheckedChange={next => { requestAction(next ? 'enable' : 'disable') }}
          />
        </div>
      </SettingRow>
      <SettingRow title={t('authenticatorApp')} description={enabled ? t('authenticatorOnHint') : t('authenticatorOffHint')} />
      <SettingRow icon={<KeyRound className="size-4 text-muted-foreground" aria-hidden />} title={t('recoveryCodes')} description={enabled ? t('recoveryCodesOnHint') : t('recoveryCodesOffHint')}>
        {enabled ? <Button type="button" variant="secondary" size="sm" disabled={twoFactor.pending !== null} onClick={() => {
          if (!verified) { twoFactor.clearError(); setCodeDraft(''); setVerifyOpen(true); return }
          requestAction('regenerate')
        }}>
          {twoFactor.pending === 'regenerate' ? t('regeneratingCodes') : t('regenerateCodes')}
        </Button> : null}
      </SettingRow>
      {enabled && !verified && <p role="status" className="px-4 py-3 text-xs text-muted-foreground">{t('sessionUnverifiedHint')}</p>}
      {errorText && !passwordModal && !verifyOpen && !twoFactor.enrollment && <FieldError className="px-4 py-3">{errorText}</FieldError>}
    </SettingsSection>

    <Dialog open={passwordModal !== null} onOpenChange={open => { if (!open) setPasswordModal(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {passwordModal === 'enable' ? t('enableTwoFactorTitle') : passwordModal === 'disable' ? t('disableTwoFactorTitle') : t('recoveryCodes')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Label className="flex flex-col items-start gap-1.5">
            {t('passwordPromptLabel')}
            <Input
              type="password"
              autoComplete="current-password"
              placeholder={t('passwordPromptPlaceholder')}
              value={passwordDraft}
              onChange={event => setPasswordDraft(event.target.value)}
            />
          </Label>
          {errorText && <FieldError>{errorText}</FieldError>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={twoFactor.pending !== null} onClick={() => setPasswordModal(null)}>{t('cancel')}</Button>
          <Button type="button" disabled={twoFactor.pending !== null || !passwordDraft} onClick={() => { void submitPasswordAction() }}>
            {passwordModal === 'disable' ? t('confirmDisable') : t('confirmEnable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={twoFactor.enrollment !== null} onOpenChange={open => { if (!open) twoFactor.cancelEnroll() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('enableTwoFactorTitle')}</DialogTitle>
        </DialogHeader>
        {twoFactor.enrollment && <div className="flex flex-col gap-4">
          {twoFactor.enrollment.secret && <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('totpSecretLabel')}</span>
            <div className="flex items-center gap-2">
              <Input readOnly value={twoFactor.enrollment.secret} aria-label={t('totpSecretLabel')} className="font-mono text-xs" />
              <Button type="button" variant="secondary" onClick={() => copyValue('secret', twoFactor.enrollment!.secret!)}>
                {copiedKey === 'secret' ? t('copied') : t('copy')}
              </Button>
            </div>
          </div>}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('totpUriLabel')}</span>
            <div className="flex items-center gap-2">
              <Input readOnly value={twoFactor.enrollment.totpURI} aria-label={t('totpUriLabel')} className="font-mono text-xs" />
              <Button type="button" variant="secondary" onClick={() => copyValue('uri', twoFactor.enrollment!.totpURI)}>
                {copiedKey === 'uri' ? t('copied') : t('copy')}
              </Button>
            </div>
          </div>
          <Label className="flex flex-col items-start gap-1.5">
            {t('totpCodeLabel')}
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t('totpCodePlaceholder')}
              value={codeDraft}
              onChange={event => setCodeDraft(event.target.value)}
            />
          </Label>
          {errorText && <FieldError>{errorText}</FieldError>}
        </div>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={twoFactor.pending !== null} onClick={twoFactor.cancelEnroll}>{t('cancel')}</Button>
          <Button type="button" disabled={twoFactor.pending !== null || !codeDraft.trim()} onClick={() => { void twoFactor.verifyCode(codeDraft) }}>
            {twoFactor.pending === 'verify' ? t('verifying') : t('confirmVerify')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={verifyOpen} onOpenChange={setVerifyOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('verifySession')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Label className="flex flex-col items-start gap-1.5">
            {t('totpCodeLabel')}
            <Input
              autoComplete="one-time-code"
              placeholder={t('totpCodePlaceholder')}
              value={codeDraft}
              onChange={event => setCodeDraft(event.target.value)}
            />
          </Label>
          {errorText && <FieldError>{errorText}</FieldError>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={twoFactor.pending !== null} onClick={() => setVerifyOpen(false)}>{t('cancel')}</Button>
          <Button type="button" disabled={twoFactor.pending !== null || !codeDraft.trim()} onClick={() => {
            void twoFactor.verifyCode(codeDraft).then(ok => { if (ok) setVerifyOpen(false) })
          }}>
            {twoFactor.pending === 'verify' ? t('verifying') : t('confirmVerify')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={twoFactor.generatedCodes !== null} onOpenChange={open => { if (!open) twoFactor.dismissCodes() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('recoveryCodes')}</DialogTitle>
        </DialogHeader>
        {twoFactor.generatedCodes && <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t('backupCodesSavedHint')}</p>
          <pre className="grid grid-cols-2 gap-1.5 rounded-lg border bg-card p-3 font-mono text-xs">
            {twoFactor.generatedCodes.map(code => <span key={code}>{code}</span>)}
          </pre>
        </div>}
        <DialogFooter>
          {twoFactor.generatedCodes && <Button type="button" variant="secondary" onClick={() => copyValue('codes', twoFactor.generatedCodes!.join('\n'))}>
            {copiedKey === 'codes' ? t('copied') : t('copy')}
          </Button>}
          <Button type="button" onClick={twoFactor.dismissCodes}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

/**
 * Frame 04 `通行密钥` section: empty state (`暂无通行密钥` + `+`), populated WebAuthn credential rows
 * with provider/device badges, creation date, rename & delete dialogs, and explicit `403` 2FA handling.
 */
export function PasskeysSection() {
  const t = useTranslations('Settings.passkeys')
  const locale = useLocale()
  const passkeysState = usePasskeys()
  const { passkeys, loading, loadError, pending, actionError } = passkeysState
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<PasskeySummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleting, setDeleting] = useState<PasskeySummary | null>(null)

  function openAdd() {
    passkeysState.clearError()
    setNewName('')
    setAdding(true)
  }

  function openRename(item: PasskeySummary) {
    passkeysState.clearError()
    setRenameDraft(item.name ?? item.providerName ?? '')
    setRenaming(item)
  }

  function submitAdd() {
    void passkeysState.add(newName).then(err => {
      if (!err) setAdding(false)
    })
  }

  function submitRename() {
    if (!renaming) return
    void passkeysState.rename(renaming.id, renameDraft).then(err => {
      if (!err) setRenaming(null)
    })
  }

  function confirmDelete() {
    if (!deleting) return
    void passkeysState.remove(deleting.id).then(err => {
      if (!err || err === 'notFound') setDeleting(null)
    })
  }

  const displayName = (item: PasskeySummary) => item.name?.trim() || item.providerName || t('unnamed')
  const inlineError = actionError && !adding && !renaming && !deleting ? passkeyErrorMessage(t, actionError) : null

  return <>
    <SettingsSection
      id="passkeys-heading"
      title={t('heading')}
      description={t('subtitle')}
      action={passkeys.length > 0 ? <Button type="button" variant="secondary" size="sm" disabled={pending !== null} onClick={openAdd}>
        <Plus data-icon />{pending === 'add' ? t('adding') : t('add')}
      </Button> : undefined}
    >
      {loading && <SettingsLoading label={t('loading')} rows={1} bare />}
      {loadError && !loading && <SettingsSaveError message={t('loadError')} retryLabel={t('retry')} onRetry={passkeysState.reload} />}
      {!loading && !loadError && passkeys.length === 0 && <SettingRow title={t('empty')}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('add')} disabled={pending !== null} onClick={openAdd}>
          <Plus data-icon />
        </Button>
      </SettingRow>}
      {passkeys.map(item => {
        const created = formatPasskeyDate(item.createdAt, locale)
        const deviceLabel = item.deviceType === 'multiDevice' ? t('deviceMulti') : t('deviceSingle')
        const subtitleParts = [
          item.providerName && item.name && item.providerName !== item.name ? item.providerName : null,
          created ? t('createdOn', { date: created }) : null,
        ].filter(Boolean)
        return <SettingRow
          key={item.id}
          icon={<KeyRound className="size-4 text-muted-foreground" aria-hidden />}
          title={displayName(item)}
          description={subtitleParts.length > 0 ? subtitleParts.join(' · ') : undefined}
        >
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary">{deviceLabel}</Badge>
            {item.backedUp && <Badge variant="outline">{t('backedUpBadge')}</Badge>}
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('rename')} disabled={pending !== null} onClick={() => openRename(item)}>
              <Pencil data-icon />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('delete')} disabled={pending !== null} onClick={() => { passkeysState.clearError(); setDeleting(item) }}>
              <Trash2 data-icon />
            </Button>
          </div>
        </SettingRow>
      })}
      {inlineError && <FieldError className="px-4 py-3">{inlineError}</FieldError>}
    </SettingsSection>

    <SettingsSection>
      <SettingRow
        title={`${t('requirePasskey')} · ${t('pendingBadge')}`}
        description={passkeys.length === 0 ? t('requirePasskeyEmptyHint') : t('requirePasskeyPendingHint')}
      >
        <Switch aria-label={t('requirePasskey')} checked={false} disabled />
      </SettingRow>
    </SettingsSection>

    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('addDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Label className="flex flex-col items-start gap-1.5">
            {t('nameLabel')}
            <Input
              maxLength={PASSKEY_NAME_MAX}
              placeholder={t('namePlaceholder')}
              value={newName}
              onChange={event => setNewName(event.target.value)}
            />
          </Label>
          {actionError && <FieldError>{passkeyErrorMessage(t, actionError)}</FieldError>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending === 'add'} onClick={() => setAdding(false)}>{t('cancel')}</Button>
          <Button type="button" disabled={pending === 'add'} onClick={submitAdd}>{pending === 'add' ? t('adding') : t('add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={renaming !== null} onOpenChange={open => { if (!open) setRenaming(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('renameDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Label className="flex flex-col items-start gap-1.5">
            {t('nameLabel')}
            <Input
              maxLength={PASSKEY_NAME_MAX}
              placeholder={t('namePlaceholder')}
              value={renameDraft}
              onChange={event => setRenameDraft(event.target.value)}
            />
          </Label>
          {actionError && <FieldError>{passkeyErrorMessage(t, actionError)}</FieldError>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => setRenaming(null)}>{t('cancel')}</Button>
          <Button type="button" disabled={pending !== null || !renameDraft.trim()} onClick={submitRename}>
            {renaming && pending === renaming.id ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteDialogTitle', { name: deleting ? displayName(deleting) : '' })}</AlertDialogTitle>
        </AlertDialogHeader>
        {actionError && <FieldError>{passkeyErrorMessage(t, actionError)}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending !== null}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending !== null} onClick={confirmDelete}>
            {deleting && pending === deleting.id ? t('deleting') : t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
