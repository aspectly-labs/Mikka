// Personal interface and appearance preferences backed by SETTINGS_REGISTRY
// (personal_setting_values generic typed KV, zero JSONB columns).
// Pure client-only items (per-device local theme/colors when appearanceSync === false,
// secondary surface/foreground/border hex overrides and local custom theme drafts)
// stay in browser localStorage under UI_LOCAL_STORAGE_KEY.

import { z } from 'zod'
import type { SettingSource, SettingValue, SettingsView } from '@mikka/protocol/settings'

export const RAIL_PAGE_IDS = ['chats', 'pulls', 'automations', 'suggestions', 'board', 'plugins', 'artifacts'] as const
export type RailPageId = (typeof RAIL_PAGE_IDS)[number]

export const RUN_KEY_ACTIONS = ['steer', 'interrupt', 'queue'] as const
export type RunKeyAction = (typeof RUN_KEY_ACTIONS)[number]
export const SIDEBAR_LAYOUTS = ['hybrid', 'columns'] as const
export const COLOR_SCHEMES = ['light', 'dark', 'system'] as const
export const CODE_SIZES = ['default', 'small', 'large'] as const
export const DIFF_VIEWS = ['unified', 'split'] as const
export const DIFF_COLORS = ['redGreen', 'blue'] as const
export const HIDDEN_FILES = ['generated', 'none', 'all'] as const
export const BACKGROUNDS = ['none', 'color'] as const
export const BACKGROUND_EFFECTS = ['none', 'colorful'] as const

export const UI_THEMES = [
  { id: 'mikka', accent: '#2365db', fill: '#ffffff', foreground: '#171717' },
  { id: 'sakura', accent: '#e85d8c', fill: '#fff5f8', foreground: '#3b1d2a' },
  { id: 'oled', accent: '#7aa2ff', fill: '#000000', foreground: '#f5f5f5' },
  { id: 'softPurple', accent: '#8b6cff', fill: '#f6f3ff', foreground: '#241b3a' },
  { id: 'terminal', accent: '#3dd68c', fill: '#101614', foreground: '#d7ffe9' },
  { id: 'deepSea', accent: '#3aa0c8', fill: '#07141c', foreground: '#d5eef8' },
  { id: 'forest', accent: '#3f8f4e', fill: '#f3f7f2', foreground: '#1b2b1c' },
  { id: 'warm', accent: '#e07a2f', fill: '#fff6ee', foreground: '#3a2416' },
  { id: 'codeCyan', accent: '#14b8c4', fill: '#f2fbfb', foreground: '#102628' },
  { id: 'contrast', accent: '#111111', fill: '#ffffff', foreground: '#000000' },
  { id: 'slate', accent: '#5b6b7c', fill: '#f4f6f8', foreground: '#1c2430' },
  { id: 'lilac', accent: '#a06bc4', fill: '#faf6fc', foreground: '#2c1e33' },
  { id: 'bright', accent: '#f2b84b', fill: '#fffdf8', foreground: '#2a2416' },
  { id: 'midnight', accent: '#8aa0ff', fill: '#0c1020', foreground: '#e8ecff' },
] as const

export type UiThemeId = (typeof UI_THEMES)[number]['id']
export const UI_THEME_IDS = UI_THEMES.map(theme => theme.id) as [UiThemeId, ...UiThemeId[]]
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const HEX = z.string().regex(HEX_COLOR_PATTERN)

export const UI_LOCAL_STORAGE_KEY = 'mikka:ui-local'

export interface CustomTheme { id: string; name: string; accent: string; fill: string; foreground: string }

export interface UiPreferences {
  /** null shows every rail page. An empty array shows none. */
  sidebarPages: RailPageId[] | null
  sidebarLayout: (typeof SIDEBAR_LAYOUTS)[number]
  pinPages: boolean
  openInDesktop: boolean
  scrollNewToTop: boolean
  enterAction: RunKeyAction
  modEnterAction: RunKeyAction
  altEnterAction: RunKeyAction
  microphone: 'system'
  appearanceSync: boolean
  colorScheme: (typeof COLOR_SCHEMES)[number]
  themeId: UiThemeId
  accent: string
  fill: string
  foreground: string
  accentDark: string | null
  fillDark: string | null
  foregroundDark: string | null
  border: string | null
  background: (typeof BACKGROUNDS)[number]
  backgroundEffect: (typeof BACKGROUND_EFFECTS)[number]
  customThemes: CustomTheme[]
  codeSize: (typeof CODE_SIZES)[number]
  diffView: (typeof DIFF_VIEWS)[number]
  diffColor: (typeof DIFF_COLORS)[number]
  hiddenFiles: (typeof HIDDEN_FILES)[number]
}

export const DEFAULT_UI: UiPreferences = {
  sidebarPages: null,
  sidebarLayout: 'hybrid',
  pinPages: false,
  openInDesktop: false,
  scrollNewToTop: true,
  enterAction: 'steer',
  modEnterAction: 'interrupt',
  altEnterAction: 'queue',
  microphone: 'system',
  appearanceSync: true,
  colorScheme: 'system',
  themeId: UI_THEMES[0].id,
  accent: UI_THEMES[0].accent,
  fill: UI_THEMES[0].fill,
  foreground: UI_THEMES[0].foreground,
  accentDark: null,
  fillDark: null,
  foregroundDark: null,
  border: null,
  background: 'none',
  backgroundEffect: 'colorful',
  customThemes: [],
  codeSize: 'default',
  diffView: 'unified',
  diffColor: 'redGreen',
  hiddenFiles: 'generated',
}

export const uiPreferencesSchema = z.object({
  sidebarLayout: z.enum(SIDEBAR_LAYOUTS),
  pinPages: z.boolean(),
  openInDesktop: z.boolean(),
  scrollNewToTop: z.boolean(),
  enterAction: z.enum(RUN_KEY_ACTIONS),
  modEnterAction: z.enum(RUN_KEY_ACTIONS),
  altEnterAction: z.enum(RUN_KEY_ACTIONS),
  microphone: z.literal('system'),
  appearanceSync: z.boolean(),
  colorScheme: z.enum(COLOR_SCHEMES),
  themeId: z.enum(UI_THEME_IDS),
  accent: HEX,
  fill: HEX,
  foreground: HEX,
  accentDark: HEX.nullable(),
  fillDark: HEX.nullable(),
  foregroundDark: HEX.nullable(),
  border: HEX.nullable(),
  background: z.enum(BACKGROUNDS),
  backgroundEffect: z.enum(BACKGROUND_EFFECTS),
  wallpaper: z.enum(BACKGROUNDS),
  customThemes: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(40), accent: HEX, fill: HEX, foreground: HEX })).max(24),
  sidebarPages: z.array(z.enum(RAIL_PAGE_IDS)).max(RAIL_PAGE_IDS.length).nullable(),
  codeSize: z.enum(CODE_SIZES),
  diffView: z.enum(DIFF_VIEWS),
  diffColor: z.enum(DIFF_COLORS),
  hiddenFiles: z.enum(HIDDEN_FILES),
}).partial()

export type UiPreferencesPatch = z.infer<typeof uiPreferencesSchema>

/** Pure client-only appearance state kept in localStorage on this device. */
const localUiSchema = z.object({
  colorScheme: z.enum(COLOR_SCHEMES),
  themeId: z.enum(UI_THEME_IDS),
  accent: HEX,
  backgroundEffect: z.enum(BACKGROUND_EFFECTS),
  fill: HEX,
  foreground: HEX,
  accentDark: HEX.nullable(),
  fillDark: HEX.nullable(),
  foregroundDark: HEX.nullable(),
  border: HEX.nullable(),
  background: z.enum(BACKGROUNDS),
  customThemes: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(40), accent: HEX, fill: HEX, foreground: HEX })).max(24),
}).partial()

export type LocalUiPreferences = z.infer<typeof localUiSchema>

/** Canonical SETTINGS_REGISTRY keys owned by personal appearance and interface settings. */
export const APPEARANCE_REGISTRY_KEYS = [
  'appearanceSync',
  'appearanceColorScheme',
  'appearanceTheme',
  'appearanceAccentColor',
  'appearanceBackgroundEffect',
  'codeFontSize',
  'diffView',
  'diffColors',
  'hiddenFiles',
] as const

export const INTERFACE_REGISTRY_KEYS = [
  'sidebarPages',
  'sidebarLayout',
  'pinPages',
  'openInDesktop',
  'scrollNewToTop',
  'enterAction',
  'modEnterAction',
  'altEnterAction',
] as const

function migrateStored(stored: unknown) {
  if (!stored || typeof stored !== 'object') return stored
  const value = { ...(stored as Record<string, unknown>) }
  if (value.hiddenFiles === 'hide' || value.hiddenFiles === 'dim') value.hiddenFiles = 'generated'
  if (value.hiddenFiles === 'show') value.hiddenFiles = 'none'
  if (value.backgroundEffect === 'gradient' || value.backgroundEffect === 'grid') value.backgroundEffect = 'colorful'
  return value
}

export function normalizeUi(stored: unknown): UiPreferences {
  const patch = uiPreferencesSchema.safeParse(migrateStored(stored) ?? {})
  const { wallpaper, ...value } = patch.success ? patch.data : {}
  return { ...DEFAULT_UI, ...value, background: wallpaper === 'color' ? wallpaper : value.background ?? DEFAULT_UI.background,
    sidebarPages: value.sidebarPages ?? DEFAULT_UI.sidebarPages }
}

export function readLocalUiPreferences(storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): LocalUiPreferences {
  if (!storage) return {}
  try {
    const raw = storage.getItem(UI_LOCAL_STORAGE_KEY)
    if (!raw) return {}
    const parsed = localUiSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function writeLocalUiPreferences(next: LocalUiPreferences, storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage) {
  if (!storage) return
  try {
    storage.setItem(UI_LOCAL_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore storage quota or private-mode refusal.
  }
}

/**
 * Resolves effective UiPreferences from P1 SETTINGS_REGISTRY values plus pure client-only state.
 * When `appearanceSync === false`, per-device `colorScheme`, `themeId`, `accent` and `backgroundEffect`
 * in `local` override the server values on this device without mutating remote settings.
 */
export function resolveUiPreferencesFromSettings(
  view: Pick<SettingsView, 'values'> | null | undefined,
  local: LocalUiPreferences = {},
): { ui: UiPreferences; sources: Record<string, SettingSource> } {
  const values = view?.values ?? {}
  const sources: Record<string, SettingSource> = {}
  for (const key of [...APPEARANCE_REGISTRY_KEYS, ...INTERFACE_REGISTRY_KEYS]) {
    sources[key] = values[key]?.source ?? 'default'
  }
  const pagesRaw = values.sidebarPages?.value
  const allRailSelected = Array.isArray(pagesRaw) && pagesRaw.length === RAIL_PAGE_IDS.length && RAIL_PAGE_IDS.every(id => pagesRaw.includes(id))
  const sidebarPages = Array.isArray(pagesRaw)
    ? (allRailSelected && values.sidebarPages?.source === 'default' ? null : pagesRaw.filter((id): id is RailPageId => (RAIL_PAGE_IDS as readonly string[]).includes(id)))
    : null
  const appearanceSync = typeof values.appearanceSync?.value === 'boolean' ? values.appearanceSync.value : DEFAULT_UI.appearanceSync
  const themeFromServer = typeof values.appearanceTheme?.value === 'string' ? values.appearanceTheme.value : DEFAULT_UI.themeId
  const themeId = (!appearanceSync && local.themeId ? local.themeId : themeFromServer) as UiThemeId
  const preset = themeById(themeId)
  const serverAccent = typeof values.appearanceAccentColor?.value === 'string' ? values.appearanceAccentColor.value : preset.accent
  const raw = {
    sidebarPages,
    sidebarLayout: values.sidebarLayout?.value ?? DEFAULT_UI.sidebarLayout,
    pinPages: values.pinPages?.value ?? DEFAULT_UI.pinPages,
    openInDesktop: values.openInDesktop?.value ?? DEFAULT_UI.openInDesktop,
    scrollNewToTop: values.scrollNewToTop?.value ?? DEFAULT_UI.scrollNewToTop,
    enterAction: values.enterAction?.value ?? DEFAULT_UI.enterAction,
    modEnterAction: values.modEnterAction?.value ?? DEFAULT_UI.modEnterAction,
    altEnterAction: values.altEnterAction?.value ?? DEFAULT_UI.altEnterAction,
    appearanceSync,
    colorScheme: !appearanceSync && local.colorScheme ? local.colorScheme : (values.appearanceColorScheme?.value ?? DEFAULT_UI.colorScheme),
    themeId,
    accent: !appearanceSync && local.accent ? local.accent : serverAccent,
    fill: local.fill ?? preset.fill,
    foreground: local.foreground ?? preset.foreground,
    accentDark: local.accentDark ?? null,
    fillDark: local.fillDark ?? null,
    foregroundDark: local.foregroundDark ?? null,
    border: local.border ?? null,
    background: local.background ?? 'none',
    backgroundEffect: !appearanceSync && local.backgroundEffect ? local.backgroundEffect : (values.appearanceBackgroundEffect?.value ?? DEFAULT_UI.backgroundEffect),
    customThemes: local.customThemes ?? [],
    codeSize: values.codeFontSize?.value ?? DEFAULT_UI.codeSize,
    diffView: values.diffView?.value ?? DEFAULT_UI.diffView,
    diffColor: values.diffColors?.value ?? DEFAULT_UI.diffColor,
    hiddenFiles: values.hiddenFiles?.value ?? DEFAULT_UI.hiddenFiles,
  }
  return { ui: normalizeUi(raw), sources }
}

/**
 * Splits a UI preference patch into server SETTINGS_REGISTRY values and client-local overrides.
 * When `appearanceSync` is false (either already or set false in this patch), theme/scheme/accent/effect
 * stay local to this device instead of writing `personal_setting_values`.
 */
export function splitUiPreferencesPatch(
  patch: UiPreferencesPatch,
  currentSync: boolean,
  currentLocal: LocalUiPreferences = {},
): { registryValues: Record<string, SettingValue | null>; nextLocal: LocalUiPreferences; localChanged: boolean } {
  const parsed = uiPreferencesSchema.parse(migrateStored(patch) ?? {})
  const effectiveSync = parsed.appearanceSync ?? currentSync
  const registryValues: Record<string, SettingValue | null> = {}
  const nextLocal: LocalUiPreferences = { ...currentLocal }
  let localChanged = false

  if (parsed.appearanceSync !== undefined) registryValues.appearanceSync = parsed.appearanceSync
  if (parsed.sidebarPages !== undefined) registryValues.sidebarPages = parsed.sidebarPages === null ? null : parsed.sidebarPages
  if (parsed.sidebarLayout !== undefined) registryValues.sidebarLayout = parsed.sidebarLayout
  if (parsed.pinPages !== undefined) registryValues.pinPages = parsed.pinPages
  if (parsed.openInDesktop !== undefined) registryValues.openInDesktop = parsed.openInDesktop
  if (parsed.scrollNewToTop !== undefined) registryValues.scrollNewToTop = parsed.scrollNewToTop
  if (parsed.enterAction !== undefined) registryValues.enterAction = parsed.enterAction
  if (parsed.modEnterAction !== undefined) registryValues.modEnterAction = parsed.modEnterAction
  if (parsed.altEnterAction !== undefined) registryValues.altEnterAction = parsed.altEnterAction
  if (parsed.codeSize !== undefined) registryValues.codeFontSize = parsed.codeSize
  if (parsed.diffView !== undefined) registryValues.diffView = parsed.diffView
  if (parsed.diffColor !== undefined) registryValues.diffColors = parsed.diffColor
  if (parsed.hiddenFiles !== undefined) registryValues.hiddenFiles = parsed.hiddenFiles

  if (effectiveSync) {
    if (parsed.colorScheme !== undefined) registryValues.appearanceColorScheme = parsed.colorScheme
    if (parsed.themeId !== undefined) registryValues.appearanceTheme = parsed.themeId
    if (parsed.accent !== undefined) registryValues.appearanceAccentColor = parsed.accent
    if (parsed.backgroundEffect !== undefined) registryValues.appearanceBackgroundEffect = parsed.backgroundEffect
  } else {
    if (parsed.colorScheme !== undefined) { nextLocal.colorScheme = parsed.colorScheme; localChanged = true }
    if (parsed.themeId !== undefined) { nextLocal.themeId = parsed.themeId; localChanged = true }
    if (parsed.accent !== undefined) { nextLocal.accent = parsed.accent; localChanged = true }
    if (parsed.backgroundEffect !== undefined) { nextLocal.backgroundEffect = parsed.backgroundEffect; localChanged = true }
  }

  const background = parsed.background ?? (parsed.wallpaper === 'color' ? 'color' : parsed.wallpaper)
  if (background !== undefined) { nextLocal.background = background; localChanged = true }
  for (const key of ['fill', 'foreground', 'accentDark', 'fillDark', 'foregroundDark', 'border', 'customThemes'] as const) {
    if (parsed[key] !== undefined) {
      ;(nextLocal as Record<string, unknown>)[key] = parsed[key]
      localChanged = true
    }
  }
  return { registryValues, nextLocal, localChanged }
}

export function themeById(id: string) {
  return UI_THEMES.find(theme => theme.id === id) ?? UI_THEMES[0]
}

/** The colors actually painted: a named theme, then any custom hex the person set. */
export function resolvedColors(ui: UiPreferences) {
  if (ui.themeId === 'mikka') return { accent: ui.accent, fill: ui.fill, foreground: ui.foreground }
  const theme = themeById(ui.themeId)
  return { accent: theme.accent, fill: theme.fill, foreground: theme.foreground }
}

let published = DEFAULT_UI
const listeners = new Set<() => void>()

export function currentUiPreferences() {
  return published
}

export function subscribeUiPreferences(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function paintToken(root: HTMLElement, name: string, value: string | null) {
  if (value) root.style.setProperty(name, value)
  else root.style.removeProperty(name)
}

/** Paints the open document and tells every reader. Named themes and custom colors map onto the tokens the app already uses. */
export function publishUiPreferences(ui: UiPreferences, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement) {
  published = ui
  for (const listener of listeners) listener()
  if (!root) return
  const colors = resolvedColors(ui)
  const dark = root.classList.contains('dark') || root.dataset.theme === 'dark'
  const accent = dark && ui.accentDark ? ui.accentDark : colors.accent
  const fill = dark && ui.fillDark ? ui.fillDark : colors.fill
  const foreground = dark && ui.foregroundDark ? ui.foregroundDark : colors.foreground
  const custom = ui.themeId !== 'mikka' || ui.background === 'color' || accent !== DEFAULT_UI.accent || fill !== DEFAULT_UI.fill || foreground !== DEFAULT_UI.foreground
  root.dataset.sidebarLayout = ui.sidebarLayout
  root.dataset.pinPages = String(ui.pinPages)
  root.dataset.scrollNewToTop = String(ui.scrollNewToTop)
  root.dataset.openInDesktop = String(ui.openInDesktop)
  root.dataset.codeSize = ui.codeSize
  root.dataset.diffView = ui.diffView
  root.dataset.diffColor = ui.diffColor
  root.dataset.hiddenFiles = ui.hiddenFiles
  root.dataset.uiTheme = ui.themeId
  root.dataset.backgroundEffect = ui.backgroundEffect
  root.style.setProperty('--ui-accent', accent)
  root.style.setProperty('--ui-fill', fill)
  root.style.setProperty('--ui-foreground', foreground)
  root.style.setProperty('--code-font-size', ui.codeSize === 'small' ? '12px' : ui.codeSize === 'large' ? '16px' : '14px')
  paintToken(root, '--mk-accent', custom ? accent : null)
  paintToken(root, '--primary', custom ? accent : null)
  paintToken(root, '--background', custom ? fill : null)
  paintToken(root, '--foreground', custom ? foreground : null)
  paintToken(root, '--card', custom ? fill : null)
  paintToken(root, '--border', ui.border)
  const accentMix = `color-mix(in srgb, ${accent} 14%, ${fill})`
  if (ui.backgroundEffect === 'colorful') {
    root.style.backgroundImage = `linear-gradient(to bottom, ${fill}, ${accentMix})`
    root.style.backgroundSize = ''
  } else {
    root.style.backgroundImage = ''
    root.style.backgroundSize = ''
  }
  root.style.backgroundColor = ui.background === 'color' ? accentMix : ''
}

export interface RunKeyEvent { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }

/** Which saved action a keydown asks for while a run is in progress. Shift and an IME never count. */
export function runKeyAction(event: RunKeyEvent, ui: UiPreferences = published): RunKeyAction | null {
  if (event.isComposing || event.shiftKey || event.key !== 'Enter') return null
  if (event.altKey && !event.metaKey && !event.ctrlKey) return ui.altEnterAction
  if ((event.metaKey || event.ctrlKey) && !event.altKey) return ui.modEnterAction
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return ui.enterAction
  return null
}
