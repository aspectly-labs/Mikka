'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Laptop, Mail, Play } from '@/components/icons'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import {
  DND_DAYS,
  DND_TIME_OPTIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SOUNDS,
  playNotificationPreview,
  useNotificationMatrix,
  type NotificationSound,
} from '@/hooks/settings/use-notification-matrix'
import { settingsHref } from '@/lib/settings-sections'

/**
 * 通知. Official builds resolve `@ui-slot/settings-notifications` from `mikka-hosted-ui`;
 * `NotificationMatrixSection` provides the public fallback composition.
 */
export { NotificationSettings } from '@ui-slot/settings-notifications'

export function NotificationMatrixSection({ workspaceId }: { workspaceId?: string }) {
  const t = useTranslations('Settings.notificationsMatrix')
  const legacyT = useTranslations('Settings.notifications')
  const state = useNotificationMatrix()
  const { matrix } = state

  if (state.loadError) {
    return <SettingsSaveError message={t('loadError')} retryLabel={t('retry')} onRetry={state.reload} />
  }
  if (state.loading) {
    return <SettingsLoading label={legacyT('loading')} rows={6} />
  }

  const startOptions = DND_TIME_OPTIONS.includes(matrix.dnd.start)
    ? DND_TIME_OPTIONS.map(value => ({ value, label: value }))
    : [{ value: matrix.dnd.start, label: matrix.dnd.start }, ...DND_TIME_OPTIONS.map(value => ({ value, label: value }))]
  const endOptions = DND_TIME_OPTIONS.includes(matrix.dnd.end)
    ? DND_TIME_OPTIONS.map(value => ({ value, label: value }))
    : [{ value: matrix.dnd.end, label: matrix.dnd.end }, ...DND_TIME_OPTIONS.map(value => ({ value, label: value }))]
  const soundOptions = NOTIFICATION_SOUNDS.map(sound => ({
    value: sound,
    label: t(`sound_${sound}` as 'sound_default'),
  }))

  const browserStatusText = state.browserPermission === 'granted'
    ? t('browserGranted')
    : state.browserPermission === 'denied'
      ? t('browserDenied')
      : state.browserPermission === 'unsupported'
        ? t('browserUnsupported')
        : t('browserDefault')

  return <div className="flex flex-col gap-6">
    <SettingsSection title={t('emailHeading')}>
      <SettingRow
        icon={<Mail className="size-4 text-muted-foreground" aria-hidden />}
        title={t('emailInvitations')}
        description={t('emailInvitationsHint')}
      >
        <Switch
          aria-label={t('emailInvitations')}
          checked={matrix.emailInvitations}
          onCheckedChange={state.setEmailInvitations}
        />
      </SettingRow>
    </SettingsSection>

    <SettingsSection title={t('systemHeading')}>
      <SettingRow title={t('systemRow')} description={t('systemRowHint')}>
        <Switch aria-label={t('systemRow')} checked={state.proactive} onCheckedChange={state.setProactive} />
      </SettingRow>
      <SettingRow title={t('soundRow')} description={t('soundRowHint')}>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('previewSound')}
            disabled={matrix.sound === 'none'}
            onClick={() => { playNotificationPreview(matrix.sound) }}
          >
            <Play data-icon />
          </Button>
          <SettingSelect
            label={t('soundRow')}
            value={matrix.sound}
            options={soundOptions}
            onValueChange={value => { if (value) state.setSound(value as NotificationSound) }}
          />
        </div>
      </SettingRow>
      <SettingRow title={`${t('customSoundRow')} · ${t('pendingBadge')}`} description={t('customSoundHint')} />
      <SettingRow title={t('pushWhenRow')} description={t('pushWhenHint')}>
        <ToggleGroup
          aria-label={t('pushWhenRow')}
          variant="segment"
          spacing={0.5}
          value={[state.pushWhen]}
          onValueChange={values => {
            const next = values[0]
            if (next === 'always' || next === 'away') state.setPushWhen(next)
          }}
        >
          <ToggleGroupItem value="always" aria-label={legacyT('always')}>{legacyT('always')}</ToggleGroupItem>
          <ToggleGroupItem value="away" aria-label={legacyT('away')}>{legacyT('away')}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <SettingRow title={t('testRow')} description={state.testStatus ? t(state.testStatus === 'sent' ? 'testSent' : state.testStatus === 'playedSound' ? 'testPlayedSound' : 'testSilent') : t('testRowHint')}>
        <Button type="button" variant="secondary" size="sm" onClick={() => state.sendTestNotification('Mikka', t('testRowHint'))}>
          {t('sendTest')}
        </Button>
      </SettingRow>
    </SettingsSection>

    <SettingsSection title={t('dndHeading')} description={t('dndSubtitle')}>
      <SettingRow title={t('dndRow')} description={t('dndRowHint')}>
        <Switch aria-label={t('dndRow')} checked={matrix.dnd.enabled} onCheckedChange={state.setDndEnabled} />
      </SettingRow>
      <SettingRow title={t('dndWindowRow')} description={t('dndWindowHint')}>
        <div className="flex items-center gap-2">
          <SettingSelect
            fluid
            label={t('dndStartLabel')}
            value={matrix.dnd.start}
            disabled={!matrix.dnd.enabled}
            options={startOptions}
            onValueChange={value => { if (value) state.setDndStart(value) }}
          />
          <span className="text-muted-foreground" aria-hidden>–</span>
          <SettingSelect
            fluid
            label={t('dndEndLabel')}
            value={matrix.dnd.end}
            disabled={!matrix.dnd.enabled}
            options={endOptions}
            onValueChange={value => { if (value) state.setDndEnd(value) }}
          />
        </div>
      </SettingRow>
      <SettingRow title={t('dndDaysRow')} description={t('dndDaysHint')}>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('dndDaysRow')}>
          {DND_DAYS.map(day => {
            const active = matrix.dnd.days.includes(day)
            return <Button
              key={day}
              type="button"
              size="xs"
              variant={active ? 'secondary' : 'outline'}
              aria-pressed={active}
              disabled={!matrix.dnd.enabled}
              onClick={() => state.toggleDndDay(day)}
            >
              {t(`day_${day}` as 'day_mon')}
            </Button>
          })}
        </div>
      </SettingRow>
    </SettingsSection>

    <SettingsSection title={t('devicesHeading')} description={t('devicesSubtitle')}>
      <SettingRow
        icon={<Laptop className="size-4 text-muted-foreground" aria-hidden />}
        title={`${t('currentBrowser')} · ${t('thisDeviceBadge')}`}
        description={browserStatusText}
      >
        {state.browserPermission === 'granted' ? (
          <Badge variant="secondary">{t('enabledBadge')}</Badge>
        ) : state.browserPermission === 'default' ? (
          <Button type="button" variant="outline" size="sm" disabled={state.requestingPermission} onClick={() => { void state.enableBrowserPush() }}>
            {state.requestingPermission ? t('enablingOnDevice') : t('enableOnDevice')}
          </Button>
        ) : null}
      </SettingRow>
    </SettingsSection>

    <SettingsSection title={t('matrixHeading')} description={t('matrixSubtitle')}>
      <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] items-center gap-3 px-4 py-2 text-xs font-medium text-muted-foreground">
        <span>{t('matrixCategoryHeader')}</span>
        <span className="text-center">{t('matrixDesktopHeader')}</span>
        <span className="text-center">{t('matrixMobileHeader')}</span>
      </div>
      {NOTIFICATION_CATEGORIES.map(category => {
        const label = t(`category_${category}` as 'category_decide')
        const hint = t(`category_${category}_hint` as 'category_decide_hint')
        return <div key={category} className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </div>
          <div className="flex justify-center">
            <Switch
              aria-label={t('channelToggleLabel', { channel: t('matrixDesktopHeader'), category: label })}
              checked={matrix.desktop[category]}
              onCheckedChange={checked => state.setChannelCategory('desktop', category, checked)}
            />
          </div>
          <div className="flex justify-center">
            <Switch
              aria-label={t('channelToggleLabel', { channel: t('matrixMobileHeader'), category: label })}
              checked={matrix.mobile[category]}
              onCheckedChange={checked => state.setChannelCategory('mobile', category, checked)}
            />
          </div>
        </div>
      })}
      <SettingRow title={t('slackRow')} description={t('slackRowHint')}>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={settingsHref('connections', workspaceId)} />}>
          {t('openIntegrations')}
        </Button>
      </SettingRow>
    </SettingsSection>

    {state.saveFailed && <SettingsSaveError message={t('saveError')} retryLabel={t('retry')} onRetry={state.retrySave} />}
  </div>
}
