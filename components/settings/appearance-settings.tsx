'use client'

import { useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { ChevronRight, Image } from '@/components/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ColorSwatch } from '@/components/ui/color-swatch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingRow, SettingSelect, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useUiPreferences } from '@/hooks/settings/use-ui-preferences'
import { settingItemPending, settingItemShown, withPendingSuffix } from '@/lib/settings-sections'
import { resolvedColors, themeById, UI_THEMES, type UiPreferences } from '@/lib/ui-preferences'
import { useTheme } from 'next-themes'

const MODES = ['system', 'light', 'dark'] as const
const selectedFrame = 'border-2 border-sidebar-primary'

/**
 * 外观, frame 1508:710 (2026-11-21 revision).
 * Synced keys persist via SETTINGS_REGISTRY (`personal_setting_values`);
 * when `appearanceSync === false`, display mode and theme stay device-local (`localStorage`).
 * Pending server capabilities (`appearance.myThemes`, `appearance.dashboardBackground`)
 * read their status from the centralized map and render `· 待接入` as disabled controls.
 */
export function AppearanceSettings() {
  const t = useTranslations('Settings.appearance')
  const common = useTranslations('Common')
  const prefs = useUiPreferences()
  const { setTheme } = useTheme()
  const [side, setSide] = useState<'light' | 'dark'>('light')
  const [advanced, setAdvanced] = useState(false)
  if (prefs.loading) return <SettingsLoading label={t('displayMode')} rows={3} />
  if (prefs.denied) return <p role="status" className="text-sm text-muted-foreground">{t('noPermission')}</p>
  if (prefs.failed) return <SettingsSaveError message={t('unavailable')} retryLabel={common('retry')} onRetry={prefs.reload} />
  const { ui, save } = prefs
  const colors = resolvedColors(ui)
  const preset = themeById(ui.themeId)
  const accent = side === 'dark' ? ui.accentDark ?? colors.accent : colors.accent
  const fill = side === 'dark' ? ui.fillDark ?? colors.fill : colors.fill
  const foreground = side === 'dark' ? ui.foregroundDark ?? colors.foreground : colors.foreground
  const hasCustomColors = colors.accent !== preset.accent
    || colors.fill !== preset.fill
    || colors.foreground !== preset.foreground
    || ui.accentDark !== null
    || ui.fillDark !== null
    || ui.foregroundDark !== null
  const pendingTag = t('pendingBadge')
  const myThemesPending = settingItemPending('appearance.myThemes')
  const dashboardBgPending = settingItemPending('appearance.dashboardBackground')

  function paint(patch: Partial<UiPreferences>) {
    void save(patch)
  }

  return <>
    <SettingsSection title={t('displayMode')}>
      <SettingRow title={t('theme')}>
        <div className="flex items-center gap-2" role="radiogroup" aria-label={t('themeLabel')}>
          {MODES.map(mode => {
            const selected = ui.colorScheme === mode
            const label = mode === 'system' ? t('system') : t(mode)
            return <Button key={mode} type="button" role="radio" aria-label={label} aria-checked={selected} variant="outline" onClick={() => { setTheme(mode); paint({ colorScheme: mode }) }}
              className={cn('h-auto w-16 min-w-0 p-1', selected && selectedFrame)}>
              <ModeThumb mode={mode} />
            </Button>
          })}
        </div>
      </SettingRow>
      <SettingRow title={t('sync')} description={t('syncHint')}>
        <SettingSelect label={t('sync')} value={ui.appearanceSync ? 'synced' : 'local'} options={[{ value: 'synced', label: t('synced') }, { value: 'local', label: t('notSynced') }]} onValueChange={value => { if (value === 'synced' || value === 'local') paint({ appearanceSync: value === 'synced' }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('themes')} action={settingItemShown('appearance.myThemes') ? <span className="text-xs text-muted-foreground">{myThemesPending ? withPendingSuffix(t('createTheme'), pendingTag) : t('createTheme')}</span> : undefined}>
      <div className="grid grid-cols-2 gap-2 p-4 min-[720px]:grid-cols-6">
        {UI_THEMES.map(theme => {
          const selected = ui.themeId === theme.id
          return <Button key={theme.id} type="button" aria-pressed={selected} variant="outline" onClick={() => paint({ themeId: theme.id, accent: theme.accent, fill: theme.fill, foreground: theme.foreground, accentDark: null, fillDark: null, foregroundDark: null, border: null })}
            className={cn('h-auto min-w-0 flex-col items-start gap-1.5 p-1.5 text-xs', selected && selectedFrame)}>
            <ThemeThumb fill={theme.fill} accent={theme.accent} foreground={theme.foreground} />
            {t(`theme_${theme.id}` as 'theme_mikka')}
          </Button>
        })}
      </div>
    </SettingsSection>
    <SettingsSection title={t('colors')} action={<div className="flex items-center gap-1.5">
      {hasCustomColors && <Button type="button" variant="ghost" size="sm" onClick={() => paint({ accent: preset.accent, fill: preset.fill, foreground: preset.foreground, accentDark: null, fillDark: null, foregroundDark: null })}>{t('resetColors')}</Button>}
      <div className="flex gap-1.5" role="radiogroup" aria-label={t('colors')}>
        {(['light', 'dark'] as const).map(value => <Button key={value} type="button" role="radio" aria-checked={side === value} size="sm" variant={side === value ? 'secondary' : 'outline'} onClick={() => setSide(value)}>{t(value)}</Button>)}
      </div>
    </div>}>
      <ColorRow label={t('accent')} value={accent} onChange={next => paint(side === 'dark' ? { accentDark: next } : { themeId: 'mikka', accent: next })} />
      <ColorRow label={t('surface')} value={fill} onChange={next => paint(side === 'dark' ? { fillDark: next } : { themeId: 'mikka', fill: next })} />
      <ColorRow label={t('foreground')} value={foreground} onChange={next => paint(side === 'dark' ? { foregroundDark: next } : { themeId: 'mikka', foreground: next })} />
    </SettingsSection>
    <Button type="button" variant="ghost" size="sm" className="self-start" aria-expanded={advanced} onClick={() => setAdvanced(open => !open)}>{t('advanced')}<ChevronRight data-icon /></Button>
    {advanced ? <SettingsSection action={ui.border !== null ? <Button type="button" variant="ghost" size="sm" onClick={() => paint({ border: null })}>{t('resetColors')}</Button> : undefined}><ColorRow label={t('border')} value={ui.border ?? '#e5e5e5'} onChange={border => paint({ border })} /></SettingsSection> : null}
    {settingItemShown('appearance.myThemes') && <SettingsSection title={t('explore')}>
      <SettingRow title={myThemesPending ? withPendingSuffix(t('exploreCard'), pendingTag) : t('exploreCard')} description={t('exploreHint')}>
        <ChevronRight className="text-muted-foreground" aria-hidden />
      </SettingRow>
    </SettingsSection>}
    <SettingsSection title={t('background')}>
      {settingItemShown('appearance.dashboardBackground') && <SettingRow title={dashboardBgPending ? withPendingSuffix(t('dashboardBackground'), pendingTag) : t('dashboardBackground')} description={t('dashboardHint')}>
        <ColorSwatch shape="tile" className="flex size-8 items-center justify-center bg-muted text-muted-foreground" aria-hidden>
          <Image data-icon />
        </ColorSwatch>
      </SettingRow>}
      <SettingRow title={t('backgroundEffect')}>
        <SettingSelect label={t('backgroundEffect')} value={ui.backgroundEffect} options={[{ value: 'colorful', label: t('effectColorful') }, { value: 'none', label: t('backgroundNone') }]} onValueChange={value => { if (value === 'none' || value === 'colorful') paint({ backgroundEffect: value }) }} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={t('code')}>
      <SettingRow title={t('codeSize')} description={t('codeSizeHint')}>
        <SettingSelect label={t('codeSize')} value={ui.codeSize} options={[{ value: 'default', label: t('codeDefault') }, { value: 'small', label: t('codeSmall') }, { value: 'large', label: t('codeLarge') }]} onValueChange={value => { if (value === 'default' || value === 'small' || value === 'large') paint({ codeSize: value }) }} />
      </SettingRow>
      <SettingRow title={t('diffView')} description={t('diffViewHint')}>
        <SettingSelect label={t('diffView')} value={ui.diffView} options={[{ value: 'unified', label: t('diffUnified') }, { value: 'split', label: t('diffSplit') }]} onValueChange={value => { if (value === 'unified' || value === 'split') paint({ diffView: value }) }} />
      </SettingRow>
      <SettingRow title={t('diffColor')} description={t('diffColorHint')}>
        <SettingSelect label={t('diffColor')} value={ui.diffColor} options={[{ value: 'redGreen', label: t('diffRedGreen') }, { value: 'blue', label: t('diffBlue') }]} onValueChange={value => { if (value === 'redGreen' || value === 'blue') paint({ diffColor: value }) }} />
      </SettingRow>
    </SettingsSection>
    <DiffPreview color={ui.diffColor} />
    <SettingsSection title={t('hidden')}>
      <SettingRow title={t('hiddenFold')} description={t('hiddenFoldHint')}>
        <SettingSelect fluid label={t('hiddenFold')} value={ui.hiddenFiles} options={[{ value: 'generated', label: t('hiddenGenerated') }, { value: 'none', label: t('hiddenNone') }, { value: 'all', label: t('hiddenAll') }]} onValueChange={value => { if (value === 'generated' || value === 'none' || value === 'all') paint({ hiddenFiles: value }) }} />
      </SettingRow>
    </SettingsSection>
  </>
}

function ModeThumb({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  const light = mode !== 'dark'
  const dark = mode !== 'light'
  return <span className="flex h-9 w-full overflow-hidden rounded-sm">
    {light ? <ColorSwatch color="#ffffff" className="flex flex-1"><ColorSwatch color="#e7e5e4" className="m-1 w-2.5" /><ColorSwatch color="#d6d3d1" className="m-1 h-1.5 flex-1" /></ColorSwatch> : null}
    {dark ? <ColorSwatch color="#171717" className="flex flex-1"><ColorSwatch color="#404040" className="m-1 w-2.5" /><ColorSwatch color="#525252" className="m-1 h-1.5 flex-1" /></ColorSwatch> : null}
  </span>
}

function ThemeThumb({ fill, accent, foreground }: { fill: string; accent: string; foreground: string }) {
  return <ColorSwatch color={fill} shape="tile" className="flex h-12 w-full">
    <ColorSwatch color={accent} className="w-4" />
    <span className="flex flex-1 flex-col gap-1 p-1.5">
      <ColorSwatch color={foreground} className="h-1.5 w-6 rounded-full" />
      <ColorSwatch color={foreground} className="h-1 w-full rounded-full opacity-30" />
      <ColorSwatch color={accent} className="mt-auto h-3 w-full rounded-sm opacity-80" />
    </span>
  </ColorSwatch>
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <SettingRow title={label}>
    <Label className="flex h-7 items-center gap-2 rounded-full border bg-background px-1.5 pr-2.5 text-sm">
      <ColorSwatch color={value} shape="chip" />
      <span className="font-mono text-xs">{value}</span>
      <Input aria-label={label} type="color" value={value} onChange={event => onChange(event.target.value)} className="sr-only" />
    </Label>
  </SettingRow>
}

function DiffPreview({ color }: { color: 'redGreen' | 'blue' }) {
  const blue = color === 'blue'
  const row = (mark: string, text: string, kind?: 'removed' | 'added') => <div className={cn(
    'grid grid-cols-[1.25rem_minmax(0,1fr)] px-3',
    kind === 'removed' && blue && 'bg-sidebar-primary/20',
    kind === 'removed' && !blue && 'bg-destructive/15',
    kind === 'added' && blue && 'bg-attention/25',
    kind === 'added' && !blue && 'bg-success/15',
  )}>
    <span>{mark}</span>
    <span className="min-w-0 break-all">{text}</span>
  </div>
  return <pre className="rounded-lg border bg-card font-mono text-xs leading-6 whitespace-pre-wrap">
    {row('1', 'export function add(a: number, b: number) {')}
    {row('-', 'return a - b;', 'removed')}
    {row('+', 'return a + b;', 'added')}
    {row('3', '}')}
  </pre>
}
