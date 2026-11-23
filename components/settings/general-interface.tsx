'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Pencil } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow, SettingSelect, SettingSwitch, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useUiPreferences } from '@/hooks/settings/use-ui-preferences'
import { RAIL_ITEMS } from '@/components/nav/rail-items'
import { RAIL_PAGE_IDS, type RailPageId, type RunKeyAction } from '@/lib/ui-preferences'

const ACTIONS = ['steer', 'interrupt', 'queue'] as const satisfies readonly RunKeyAction[]
type MicPermissionState = 'unavailable' | 'prompt' | 'granted' | 'denied'

/** 常规, frame 1508:588. Interface and composer key bindings persist via SETTINGS_REGISTRY. */
export function GeneralInterface() {
  const t = useTranslations('Settings.appearance')
  const ti = useTranslations('Settings.interface')
  const nav = useTranslations()
  const common = useTranslations('Common')
  const prefs = useUiPreferences()
  const [pagesOpen, setPagesOpen] = useState(false)
  const [draftPages, setDraftPages] = useState<RailPageId[]>([])
  const [micState, setMicState] = useState<MicPermissionState>('unavailable')
  const [micDevices, setMicDevices] = useState<readonly { value: string; label: string }[]>([])
  const [selectedMic, setSelectedMic] = useState('default')
  const [requestingMic, setRequestingMic] = useState(false)

  const loadAudioInputs = useCallback(async (defaultLabel: string) => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices
        .filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default')
        .map(device => ({ value: device.deviceId, label: device.label || defaultLabel }))
      setMicDevices([{ value: 'default', label: defaultLabel }, ...inputs])
    } catch {
      setMicDevices([{ value: 'default', label: defaultLabel }])
    }
  }, [])

  const defaultMicLabel = t('systemDefault')
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setMicState('unavailable')
      return
    }
    let cancelled = false
    let cleanup: (() => void) | undefined
    async function inspectPermission() {
      if (!navigator.permissions?.query) {
        if (!cancelled) setMicState('prompt')
        return
      }
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        if (cancelled) return
        const sync = () => {
          if (cancelled) return
          const next: MicPermissionState = status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'prompt'
          setMicState(next)
          if (next === 'granted') void loadAudioInputs(defaultMicLabel)
        }
        sync()
        status.addEventListener('change', sync)
        cleanup = () => status.removeEventListener('change', sync)
      } catch {
        if (!cancelled) setMicState('prompt')
      }
    }
    void inspectPermission()
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [defaultMicLabel, loadAudioInputs])

  async function requestMicrophone() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || requestingMic) return
    setRequestingMic(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      setMicState('granted')
      await loadAudioInputs(defaultMicLabel)
    } catch {
      setMicState('denied')
    } finally {
      setRequestingMic(false)
    }
  }

  if (prefs.loading) return <SettingsLoading label={t('interface')} rows={4} />
  if (prefs.denied) return <p role="status" className="text-sm text-muted-foreground">{t('noPermission')}</p>
  if (prefs.failed) return <SettingsSaveError message={t('unavailable')} retryLabel={common('retry')} onRetry={prefs.reload} />
  const { ui, save } = prefs
  const actionOptions = ACTIONS.map(value => ({ value, label: t(value) }))
  const pages = ui.sidebarPages ?? RAIL_PAGE_IDS
  const micDescription = micState === 'granted' ? t('microphoneHint') : micState === 'denied' ? ti('microphoneDeniedHint') : ti('microphoneAccessHint')
  const micOptions = micDevices.length > 0 ? micDevices : [{ value: 'default', label: defaultMicLabel }]

  return <>
    <SettingsSection title={t('interface')}>
      <SettingRow title={t('sidebarPages')} description={t('sidebarPagesHint')}>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t('sidebarPages')} onClick={() => { setDraftPages([...pages]); setPagesOpen(true) }}><Pencil /></Button>
      </SettingRow>
      <SettingRow title={t('sidebarLayout')} description={t('sidebarLayoutHint')}>
        <SettingSelect label={t('sidebarLayout')} value={ui.sidebarLayout} options={[{ value: 'hybrid', label: t('hybrid') }, { value: 'columns', label: t('columns') }]} onValueChange={value => { if (value === 'hybrid' || value === 'columns') void save({ sidebarLayout: value }) }} />
      </SettingRow>
      <SettingRow title={t('pinPages')} description={t('pinPagesHint')}>
        <SettingSwitch label={t('pinPages')} checked={ui.pinPages} onCheckedChange={checked => { void save({ pinPages: checked }) }} />
      </SettingRow>
      <SettingRow title={t('openInApp')} description={t('openInAppHint')}>
        <SettingSwitch label={t('openInApp')} checked={ui.openInDesktop} onCheckedChange={checked => { void save({ openInDesktop: checked }) }} />
      </SettingRow>
      <SettingRow title={t('scrollTop')} description={t('scrollTopHint')}>
        <SettingSwitch label={t('scrollTop')} checked={ui.scrollNewToTop} onCheckedChange={checked => { void save({ scrollNewToTop: checked }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('input')}>
      <SettingRow title={t('enter')} description={t('enterHint')}>
        <SettingSelect label={t('enter')} value={ui.enterAction} options={actionOptions} onValueChange={value => { if (isAction(value)) void save({ enterAction: value }) }} />
      </SettingRow>
      <SettingRow title={t('modEnter')} description={t('modEnterHint')}>
        <SettingSelect label={t('modEnter')} value={ui.modEnterAction} options={actionOptions} onValueChange={value => { if (isAction(value)) void save({ modEnterAction: value }) }} />
      </SettingRow>
      <SettingRow title={t('altEnter')} description={t('altEnterHint')}>
        <SettingSelect label={t('altEnter')} value={ui.altEnterAction} options={actionOptions} onValueChange={value => { if (isAction(value)) void save({ altEnterAction: value }) }} />
      </SettingRow>
      <SettingRow title={t('microphone')} description={micDescription}>
        {micState === 'granted'
          ? <SettingSelect label={t('microphone')} value={selectedMic} options={micOptions} onValueChange={value => { if (value) setSelectedMic(value) }} />
          : micState === 'prompt' || micState === 'denied'
            ? <Button type="button" variant="ghost" size="sm" busy={requestingMic} onClick={() => void requestMicrophone()}>{ti('allowAccess')}</Button>
            : <span className="text-sm text-muted-foreground">{defaultMicLabel}</span>}
      </SettingRow>
    </SettingsSection>
    <Dialog open={pagesOpen} onOpenChange={setPagesOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('sidebarPages')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-2">
          {RAIL_ITEMS.map(item => {
            const checked = draftPages.includes(item.id)
            return <Label key={item.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{nav(item.label)}</span>
              <SettingSwitch label={nav(item.label)} checked={checked} onCheckedChange={next => {
                setDraftPages(current => next ? [...current, item.id] : current.filter(id => id !== item.id))
              }} />
            </Label>
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setPagesOpen(false)}>{common('cancel')}</Button>
          <Button type="button" onClick={() => { void save({ sidebarPages: draftPages.length === RAIL_PAGE_IDS.length ? null : draftPages }); setPagesOpen(false) }}>{common('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

function isAction(value: string | null): value is RunKeyAction {
  return value === 'steer' || value === 'interrupt' || value === 'queue'
}
