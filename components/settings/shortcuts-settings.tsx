'use client'

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import type { SettingsView } from '@mikka/protocol/settings'
import { Ellipsis } from '@/components/icons'
import { useTranslations } from '@/lib/intl/i18n-client'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import { ShortcutKeys, useIsApplePlatform } from '@/components/shortcut-keys'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { FieldError } from '@/components/ui/field'
import { SearchInput } from '@/components/ui/search-input'
import { SettingsTable } from '@/components/ui/settings-layout'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettingRow, SettingSelect, SettingSwitch, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { useLiveKey } from '@/hooks/use-live-key'
import { fetchSettingsData, settingsReadOptions } from '@/lib/settings-data'
import { withPendingSuffix } from '@/lib/settings-sections'
import { settingsKeys } from '@/lib/swr/keys'

export interface ShortcutsSettingsProps {
  workspaceId?: string
}

type CommandKey =
  | 'searchOpen'
  | 'sidebarToggle'
  | 'reviewOpen'
  | 'settingsOpen'
  | 'taskCreate'
  | 'boardAssistantToggle'
  | 'detailsToggle'
  | 'devicesAdd'
  | 'themeToggle'
  | 'composerEnter'
  | 'composerNewline'
  | 'composerModEnter'
  | 'composerAltEnter'
  | 'listNext'
  | 'listPrev'
  | 'pullNext'
  | 'pullPrev'
  | 'pullFilter'
  | 'boardAssign'
  | 'paneResize'
  | 'dialogClose'

type ScopeKey =
  | 'always'
  | 'workspaceIdle'
  | 'workspaceTask'
  | 'board'
  | 'details'
  | 'devices'
  | 'notTyping'
  | 'composer'
  | 'dialogOrComposer'
  | 'listFocused'
  | 'pullListIdle'
  | 'boardCardIdle'
  | 'splitDivider'
  | 'dialogOrEditor'

interface ShortcutCatalogEntry {
  id: string
  /** Optional `SETTINGS_REGISTRY` action id (`keyboardShortcuts.<actionId>`) when P9 backend is active. */
  actionId?: string
  commandKey: CommandKey
  defaultKeys: readonly string[]
  scopeKey: ScopeKey
  keywords: readonly string[]
}

/**
 * Mikka's verified keyboard shortcut catalog:
 * - The 9 configurable global/workspace/page actions from P9 (`keyboardShortcuts.*`).
 * - Built-in composer, list, pull-request directory, board, split-pane, and dialog bindings.
 */
const SHORTCUT_CATALOG: readonly ShortcutCatalogEntry[] = [
  { id: 'search.open', actionId: 'search.open', commandKey: 'searchOpen', defaultKeys: ['mod', 'K'], scopeKey: 'always', keywords: ['search', 'command', 'palette', 'cmd+k', 'find'] },
  { id: 'sidebar.toggle', actionId: 'sidebar.toggle', commandKey: 'sidebarToggle', defaultKeys: ['mod', 'B'], scopeKey: 'always', keywords: ['sidebar', 'navigation', 'panel'] },
  { id: 'review.open', actionId: 'review.open', commandKey: 'reviewOpen', defaultKeys: ['mod', 'shift', 'B'], scopeKey: 'workspaceTask', keywords: ['review', 'diff', 'browser', 'right'] },
  { id: 'settings.open', actionId: 'settings.open', commandKey: 'settingsOpen', defaultKeys: ['mod', ','], scopeKey: 'always', keywords: ['settings', 'preferences', 'comma'] },
  { id: 'task.create', actionId: 'task.create', commandKey: 'taskCreate', defaultKeys: ['C'], scopeKey: 'workspaceIdle', keywords: ['create', 'new', 'task', 'issue'] },
  { id: 'board.assistant.toggle', actionId: 'board.assistant.toggle', commandKey: 'boardAssistantToggle', defaultKeys: ['mod', 'J'], scopeKey: 'board', keywords: ['board', 'assistant', 'ai', 'panel'] },
  { id: 'details.toggle', actionId: 'details.toggle', commandKey: 'detailsToggle', defaultKeys: ['mod', 'I'], scopeKey: 'details', keywords: ['details', 'inspector', 'panel'] },
  { id: 'devices.add', actionId: 'devices.add', commandKey: 'devicesAdd', defaultKeys: ['mod', 'N'], scopeKey: 'devices', keywords: ['device', 'computer', 'add', 'pair'] },
  { id: 'theme.toggle', actionId: 'theme.toggle', commandKey: 'themeToggle', defaultKeys: ['D'], scopeKey: 'notTyping', keywords: ['theme', 'dark', 'light', 'appearance'] },
  { id: 'composer.enter', commandKey: 'composerEnter', defaultKeys: ['Enter'], scopeKey: 'composer', keywords: ['send', 'enter', 'steer', 'submit'] },
  { id: 'composer.newline', commandKey: 'composerNewline', defaultKeys: ['shift', 'Enter'], scopeKey: 'composer', keywords: ['newline', 'break', 'shift+enter'] },
  { id: 'composer.modEnter', commandKey: 'composerModEnter', defaultKeys: ['mod', 'Enter'], scopeKey: 'dialogOrComposer', keywords: ['submit', 'send', 'save', 'form'] },
  { id: 'composer.altEnter', commandKey: 'composerAltEnter', defaultKeys: ['alt', 'Enter'], scopeKey: 'composer', keywords: ['queue', 'option+enter', 'alt+enter'] },
  { id: 'list.next', commandKey: 'listNext', defaultKeys: ['↓'], scopeKey: 'listFocused', keywords: ['down', 'next', 'arrow', 'list'] },
  { id: 'list.prev', commandKey: 'listPrev', defaultKeys: ['↑'], scopeKey: 'listFocused', keywords: ['up', 'previous', 'arrow', 'list'] },
  { id: 'pull.next', commandKey: 'pullNext', defaultKeys: ['J'], scopeKey: 'pullListIdle', keywords: ['pr', 'pull', 'next', 'j'] },
  { id: 'pull.prev', commandKey: 'pullPrev', defaultKeys: ['K'], scopeKey: 'pullListIdle', keywords: ['pr', 'pull', 'previous', 'k'] },
  { id: 'pull.filter', commandKey: 'pullFilter', defaultKeys: ['/'], scopeKey: 'pullListIdle', keywords: ['pr', 'filter', 'slash', 'search'] },
  { id: 'board.assign', commandKey: 'boardAssign', defaultKeys: ['A'], scopeKey: 'boardCardIdle', keywords: ['assign', 'owner', 'board', 'member'] },
  { id: 'pane.resize', commandKey: 'paneResize', defaultKeys: ['←', '→'], scopeKey: 'splitDivider', keywords: ['resize', 'split', 'column', 'width'] },
  { id: 'dialog.close', commandKey: 'dialogClose', defaultKeys: ['Esc'], scopeKey: 'dialogOrEditor', keywords: ['escape', 'close', 'cancel', 'dismiss'] },
]

const CODE_DISPLAY: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
}

const NAVIGATION_CODES = new Set([
  'Space', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace',
])

/** Converts a normalized binding such as `Mod+Shift+KeyB` into `ShortcutKeys` tokens (`['mod', 'shift', 'B']`). */
function parseBindingTokens(binding: string, apple: boolean): readonly string[] {
  if (!binding.trim()) return []
  return binding.split('+').map(part => {
    const token = part.trim()
    if (token === 'Mod') return 'mod'
    if (token === 'Alt') return 'alt'
    if (token === 'Shift') return 'shift'
    if (token === 'Meta') return apple ? '⌘' : 'Win'
    if (token === 'Ctrl') return apple ? '⌃' : 'Ctrl'
    if (token.startsWith('Key') && token.length === 4) return token.slice(3)
    if (token.startsWith('Digit') && token.length === 6) return token.slice(5)
    return CODE_DISPLAY[token] ?? token
  })
}

/** Captures a physical keyboard chord into P9's normalized format (`Mod+Shift+KeyK`), or returns `null` when unsupported. */
function capturePhysicalBinding(event: ReactKeyboardEvent<HTMLElement>, apple: boolean): string | null {
  const code = event.code
  if (!code || /^(?:Meta|Control|Alt|Shift)(?:Left|Right)?$/.test(code)) return null
  const primary = apple ? event.metaKey : event.ctrlKey
  const secondaryCtrl = apple ? event.ctrlKey : false
  const secondaryMeta = !apple ? event.metaKey : false
  const modifiers: string[] = []
  if (primary) modifiers.push('Mod')
  if (secondaryCtrl) modifiers.push('Ctrl')
  if (secondaryMeta) modifiers.push('Meta')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  const validCode = /^Key[A-Z]$/.test(code)
    || /^Digit[0-9]$/.test(code)
    || /^F(?:[1-9]|1[0-2])$/.test(code)
    || Object.hasOwn(CODE_DISPLAY, code)
    || NAVIGATION_CODES.has(code)
  if (!validCode) return null
  if (NAVIGATION_CODES.has(code) && !modifiers.some(mod => mod !== 'Shift')) return null
  return [...modifiers, code].join('+')
}

interface ConflictBody {
  error?: string
  conflicts?: Array<{ actions?: [string, string] }>
}

/**
 * 快捷键, Frame 08 (1508:2, 776px wide table).
 * Renders Voice Input and Terminal cards (`· 待接入`), instant search filter, and a borderless `r=8`
 * gray-header table (`SettingsTable`) with `ShortcutKeys` (`<Kbd>`) pills. Automatically activates
 * personal binding customization & reset when `keyboardShortcuts.*` is exposed by `/api/settings/personal`.
 */
export function ShortcutsSettings({ workspaceId }: ShortcutsSettingsProps = {}) {
  const t = useTranslations('Settings.shortcutsPage')
  const common = useTranslations('Common')
  const apple = useIsApplePlatform()
  const [query, setQuery] = useState('')
  const [recordingEntry, setRecordingEntry] = useState<ShortcutCatalogEntry | null>(null)
  const [capturedBinding, setCapturedBinding] = useState<string | null>(null)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  const swrKey = workspaceId ? (['settings:personal:shortcuts', workspaceId] as const) : settingsKeys.personalRegistry()
  const url = workspaceId
    ? `/api/settings/personal?workspaceId=${encodeURIComponent(workspaceId)}`
    : '/api/settings/personal'
  const read = useSWR<SettingsView>(swrKey, () => fetchSettingsData<SettingsView>(url), settingsReadOptions)
  useLiveKey('workspace_settings', workspaceId ?? null, [unstable_serialize(swrKey)], workspaceId ?? null)

  const values = read.data?.values
  const canCustomize = Boolean(values?.['keyboardShortcuts.search.open'])
  const pendingTag = t('pendingBadge')

  const rows = SHORTCUT_CATALOG.map(entry => {
    const registryEntry = entry.actionId ? values?.[`keyboardShortcuts.${entry.actionId}`] : undefined
    const isPersonal = registryEntry?.source === 'personal'
    const rawValue = typeof registryEntry?.value === 'string' ? registryEntry.value : null
    const keys = rawValue !== null ? parseBindingTokens(rawValue, apple) : entry.defaultKeys
    const commandLabel = t(`commands.${entry.commandKey}`)
    const scopeLabel = t(`scopes.${entry.scopeKey}`)
    return {
      entry,
      commandLabel,
      scopeLabel,
      keys,
      isPersonal,
      disabled: rawValue === '',
    }
  })

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? rows.filter(row => {
        const keyText = row.keys.join(' ').toLowerCase()
        return row.commandLabel.toLowerCase().includes(normalizedQuery)
          || row.scopeLabel.toLowerCase().includes(normalizedQuery)
          || keyText.includes(normalizedQuery)
          || row.entry.keywords.some(keyword => keyword.includes(normalizedQuery))
      })
    : rows

  const hasCustomBindings = canCustomize && rows.some(row => row.isPersonal)

  async function patchShortcut(actionId: string, nextValue: string | null): Promise<boolean> {
    setSaving(true)
    setRecordError(null)
    setPageError(null)
    try {
      const response = await fetch(withBasePath(url), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { [`keyboardShortcuts.${actionId}`]: nextValue } }),
      })
      if (response.status === 409) {
        const body = await response.json().catch(() => null) as ConflictBody | null
        const pair = body?.conflicts?.[0]?.actions
        const otherId = pair?.find(id => id !== actionId) ?? pair?.[0]
        const otherRow = SHORTCUT_CATALOG.find(item => item.actionId === otherId)
        const otherName = otherRow ? t(`commands.${otherRow.commandKey}`) : (otherId ?? '')
        setRecordError(t('conflictError', { other: otherName }))
        return false
      }
      if (!response.ok) {
        setRecordError(t('saveError'))
        setPageError(t('saveError'))
        return false
      }
      const nextView = await response.json() as SettingsView
      await read.mutate(nextView, { revalidate: false })
      return true
    } catch {
      setRecordError(t('saveError'))
      setPageError(t('saveError'))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handleResetAll() {
    setResetting(true)
    setPageError(null)
    try {
      const resetUrl = workspaceId
        ? `/api/settings/personal/reset?workspaceId=${encodeURIComponent(workspaceId)}`
        : '/api/settings/personal/reset'
      const response = await fetch(withBasePath(resetUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'keyboard_shortcuts' }),
      })
      if (!response.ok) throw new Error('Shortcut reset failed')
      const nextView = await response.json() as SettingsView
      await read.mutate(nextView, { revalidate: false })
    } catch {
      setPageError(t('saveError'))
    } finally {
      setResetting(false)
    }
  }

  async function saveRecordedBinding() {
    if (!recordingEntry?.actionId || !capturedBinding) return
    const ok = await patchShortcut(recordingEntry.actionId, capturedBinding)
    if (ok) {
      setRecordingEntry(null)
      setCapturedBinding(null)
    }
  }

  const recordingRow = recordingEntry ? rows.find(row => row.entry.id === recordingEntry.id) : null
  const previewTokens = capturedBinding ? parseBindingTokens(capturedBinding, apple) : null

  return <div className="flex flex-col gap-6">
    <SettingsSection id="shortcuts-voice" title={t('voiceTitle')}>
      <SettingRow title={withPendingSuffix(t('voiceGesture'), pendingTag)} description={t('voiceGestureHint')}>
        <SettingSelect
          fluid
          label={t('voiceGesture')}
          value="hold"
          disabled
          options={[{ value: 'hold', label: t('holdToTalk') }]}
          onValueChange={() => {}}
        />
      </SettingRow>
    </SettingsSection>

    <SettingsSection id="shortcuts-terminal" title={t('terminalTitle')}>
      <SettingRow title={withPendingSuffix(t('optionAsMeta'), pendingTag)} description={t('optionAsMetaHint')}>
        <SettingSwitch label={t('optionAsMeta')} checked={false} disabled onCheckedChange={() => {}} />
      </SettingRow>
    </SettingsSection>

    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchInput
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="h-(--control-sm) w-64 max-w-full"
        />
        {canCustomize ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            busy={resetting}
            disabled={!hasCustomBindings}
            onClick={handleResetAll}
          >
            {t('resetDefaults')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {withPendingSuffix(t('customizeBindings'), pendingTag)}
          </span>
        )}
      </div>

      {read.error && !read.data ? (
        <SettingsSaveError message={t('loadError')} retryLabel={common('retry')} onRetry={() => { void read.mutate() }} />
      ) : null}
      {pageError ? (
        <SettingsSaveError message={pageError} retryLabel={common('retry')} onRetry={() => { setPageError(null); void read.mutate() }} />
      ) : null}

      <SettingsTable>
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[44%] pl-3">
                <span>{t('columnCommand')}</span>
                <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">{filtered.length}</span>
              </TableHead>
              <TableHead className="w-[24%]">{t('columnKeys')}</TableHead>
              <TableHead className={cn(canCustomize ? 'w-[24%]' : 'w-[32%] pr-3')}>{t('columnScope')}</TableHead>
              {canCustomize ? (
                <TableHead className="w-[8%] pr-2 text-right">
                  <span className="sr-only">{t('columnActions')}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-border/70">
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canCustomize ? 4 : 3} className="py-6 pl-3 text-sm text-muted-foreground">
                  {t('noMatch')}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(({ entry, commandLabel, scopeLabel, keys, isPersonal, disabled }) => (
                <TableRow key={entry.id}>
                  <TableCell className="py-3 pl-3 font-medium whitespace-normal">
                    <span>{commandLabel}</span>
                    {isPersonal ? (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">· {t('sourcePersonal')}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="py-3">
                    {disabled || keys.length === 0 ? (
                      <span className="text-xs text-muted-foreground">{t('disabled')}</span>
                    ) : (
                      <ShortcutKeys keys={keys} />
                    )}
                  </TableCell>
                  <TableCell className={cn('py-3 text-xs text-muted-foreground whitespace-normal', !canCustomize && 'pr-3')}>
                    {scopeLabel}
                  </TableCell>
                  {canCustomize ? (
                    <TableCell className="py-3 pr-2 text-right">
                      {entry.actionId ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button type="button" variant="ghost" size="icon-sm" disabled={saving || resetting} aria-label={t('rowActions', { command: commandLabel })} />}
                          >
                            <Ellipsis />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuGroup>
                              <DropdownMenuItem onClick={() => {
                                setRecordingEntry(entry)
                                setCapturedBinding(null)
                                setRecordError(null)
                              }}>
                                {t('recordShortcut')}
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={!isPersonal} onClick={() => { if (entry.actionId) void patchShortcut(entry.actionId, null) }}>
                                {t('resetRow')}
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={disabled} onClick={() => { if (entry.actionId) void patchShortcut(entry.actionId, '') }}>
                                {t('disableRow')}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </SettingsTable>
    </div>

    <Dialog open={recordingEntry !== null} onOpenChange={open => { if (!open && !saving) { setRecordingEntry(null); setCapturedBinding(null); setRecordError(null) } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('recordDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div
          tabIndex={0}
          role="textbox"
          aria-readonly="true"
          aria-label={t('recordDialogTitle')}
          onKeyDown={event => {
            if (event.key === 'Tab') return
            event.preventDefault()
            event.stopPropagation()
            const next = capturePhysicalBinding(event, apple)
            if (!next) {
              setRecordError(t('invalidShortcut'))
              return
            }
            setRecordError(null)
            setCapturedBinding(next)
          }}
          className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border border-border px-4 py-4 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {previewTokens && previewTokens.length > 0 ? (
            <ShortcutKeys keys={previewTokens} />
          ) : recordingRow && recordingRow.keys.length > 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('recordCurrent', { keys: '' })}</span>
              <ShortcutKeys keys={recordingRow.keys} />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('recordWaiting')}</p>
        </div>
        {recordError ? <FieldError>{recordError}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => { setRecordingEntry(null); setCapturedBinding(null); setRecordError(null) }}>
            {common('cancel')}
          </Button>
          <Button type="button" busy={saving} disabled={!capturedBinding} onClick={saveRecordedBinding}>
            {common('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
