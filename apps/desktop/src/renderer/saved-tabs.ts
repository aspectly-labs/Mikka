import { savedTabs, type SavedTabs } from '@mikka/protocol/bridge'

export const SAVED_TABS_KEY = 'mikka:desktop:saved-tabs:v1'
export const MAX_SAVED_TABS = 50

const NEVER_PERSIST_PATHS = [
  /^\/(?:en\/|zh-CN\/)?(?:sign-in|sign-up|forgot-password|reset-password|verify-email|oauth|device)(?:\/|$)/,
  /^\/(?:en\/|zh-CN\/)?(?:invite|organization-invite|a|threads\/shared)(?:\/|$)/,
]
const SENSITIVE_QUERY_KEY = /^(?:access_token|refresh_token|id_token|token|code|secret|password|credential|state|api[_-]?key|key|authorization|auth)$/i

/** Only ordinary in-app routes belong in local tab recovery data. */
export function persistableHref(href: string): string | null {
  try {
    if (!href.startsWith('/') || href.startsWith('//')) return null
    const url = new URL(href, 'https://mikka.invalid')
    if (url.origin !== 'https://mikka.invalid') return null
    const appPath = url.pathname.replace(/^\/mikka(?=\/|$)/, '') || '/'
    if (NEVER_PERSIST_PATHS.some(pattern => pattern.test(appPath))) return null
    for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return null
    return `${url.pathname}${url.search}${url.hash}`.slice(0, 2048)
  } catch {
    return null
  }
}

export function createSavedTabs(href: string): SavedTabs {
  return { items: [{ entries: [persistableHref(href) ?? '/'], index: 0 }], active: 0 }
}

export function readSavedTabs(storage: Pick<Storage, 'getItem'>): SavedTabs | null {
  try {
    const raw = storage.getItem(SAVED_TABS_KEY)
    if (!raw) return null
    const parsed = savedTabs.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.items.length === 0 || parsed.data.active >= parsed.data.items.length) return null
    const items: SavedTabs['items'] = []
    let active = -1
    let keptBeforeActive = 0
    for (let tabIndex = 0; tabIndex < parsed.data.items.length; tabIndex++) {
      const tab = parsed.data.items[tabIndex]!
      const entries: string[] = []
      let keptAtOrBefore = 0
      for (let entryIndex = 0; entryIndex < tab.entries.length; entryIndex++) {
        const safe = persistableHref(tab.entries[entryIndex]!)
        if (!safe) continue
        entries.push(safe)
        if (entryIndex <= tab.index) keptAtOrBefore++
      }
      if (entries.length === 0) continue
      if (tabIndex === parsed.data.active) active = items.length
      else if (tabIndex < parsed.data.active) keptBeforeActive++
      items.push({ entries, index: keptAtOrBefore > 0 ? keptAtOrBefore - 1 : 0 })
    }
    if (items.length === 0) return null
    return { items, active: active >= 0 ? active : Math.min(keptBeforeActive, items.length - 1) }
  } catch {
    return null
  }
}

export function writeSavedTabs(storage: Pick<Storage, 'setItem'>, value: SavedTabs): boolean {
  const parsed = savedTabs.safeParse(value)
  if (!parsed.success || parsed.data.items.length === 0 || parsed.data.active >= parsed.data.items.length) return false
  const items = parsed.data.items.map(tab => {
    const entries = tab.entries.map(entry => persistableHref(entry))
    if (entries.some(entry => entry === null)) return null
    return { entries: entries as string[], index: tab.index }
  })
  if (items.some(item => item === null)) return false
  try {
    storage.setItem(SAVED_TABS_KEY, JSON.stringify({ items, active: parsed.data.active }))
    return true
  } catch {
    return false
  }
}

export function recordNavigation(tabs: SavedTabs, href: string, mode: 'push' | 'replace'): SavedTabs {
  const items = tabs.items.map(tab => ({ ...tab, entries: [...tab.entries] }))
  const active = Math.min(tabs.active, items.length - 1)
  const tab = items[active]
  if (!tab) return createSavedTabs(href)
  const safeHref = persistableHref(href)
  if (!safeHref) return { items, active }
  if (mode === 'replace') tab.entries[tab.index] = safeHref
  else if (tab.entries[tab.index] !== safeHref) {
    tab.entries = [...tab.entries.slice(0, tab.index + 1), safeHref].slice(-50)
    tab.index = tab.entries.length - 1
  }
  return { items, active }
}

export function recordHistoryLocation(tabs: SavedTabs, href: string): SavedTabs {
  const items = tabs.items.map(tab => ({ ...tab, entries: [...tab.entries] }))
  const active = Math.min(tabs.active, items.length - 1)
  const tab = items[active]
  if (!tab) return createSavedTabs(href)
  const safeHref = persistableHref(href)
  if (!safeHref) return { items, active }
  const matches = tab.entries.map((entry, index) => entry === safeHref ? index : -1).filter(index => index >= 0)
  if (matches.length) tab.index = matches.reduce((best, index) => Math.abs(index - tab.index) < Math.abs(best - tab.index) ? index : best)
  else {
    tab.entries = [...tab.entries.slice(0, tab.index + 1), safeHref].slice(-50)
    tab.index = tab.entries.length - 1
  }
  return { items, active }
}

export function activateTab(tabs: SavedTabs, index: number): SavedTabs {
  if (index < 0 || index >= tabs.items.length) return tabs
  return { ...tabs, active: index }
}

export function addTab(tabs: SavedTabs, href: string): SavedTabs {
  if (tabs.items.length >= MAX_SAVED_TABS) return tabs
  return { items: [...tabs.items, { entries: [persistableHref(href) ?? '/'], index: 0 }], active: tabs.items.length }
}

export function closeTab(tabs: SavedTabs, index: number, fallbackHref: string): SavedTabs {
  if (index < 0 || index >= tabs.items.length) return tabs
  if (tabs.items.length === 1) return createSavedTabs(fallbackHref)
  const items = tabs.items.filter((_, itemIndex) => itemIndex !== index)
  const active = index < tabs.active ? tabs.active - 1 : index === tabs.active ? Math.min(index, items.length - 1) : tabs.active
  return { items, active }
}

/** Keeps only the tab at `index` (Close Other Tabs); it becomes the active one. */
export function closeOtherTabs(tabs: SavedTabs, index: number): SavedTabs {
  const keep = tabs.items[index]
  if (!keep || tabs.items.length === 1) return tabs
  return { items: [keep], active: 0 }
}

/** Closes every tab after `index` (Close Tabs to the Right); an active tab among them hands over to `index`. */
export function closeTabsToRight(tabs: SavedTabs, index: number): SavedTabs {
  if (index < 0 || index >= tabs.items.length - 1) return tabs
  return { items: tabs.items.slice(0, index + 1), active: tabs.active > index ? index : tabs.active }
}

/** Closes every tab before `index` (Close Tabs to the Left); an active tab among them hands over to `index`. */
export function closeTabsToLeft(tabs: SavedTabs, index: number): SavedTabs {
  if (index <= 0 || index >= tabs.items.length) return tabs
  return { items: tabs.items.slice(index), active: tabs.active < index ? 0 : tabs.active - index }
}

/** A copy of the tab at `index`, with its own back/forward history, opened right after it and made active. */
export function duplicateTab(tabs: SavedTabs, index: number): SavedTabs {
  const source = tabs.items[index]
  if (!source || tabs.items.length >= MAX_SAVED_TABS) return tabs
  const copy = { entries: [...source.entries], index: source.index }
  return { items: [...tabs.items.slice(0, index + 1), copy, ...tabs.items.slice(index + 1)], active: index + 1 }
}

/** ⌘1–⌘8 pick that tab when it exists; ⌘9 always picks the last tab, as browsers do. */
export function tabForNumber(count: number, number: number): number | null {
  if (count < 1 || !Number.isInteger(number) || number < 1 || number > 9) return null
  if (number === 9) return count - 1
  return number <= count ? number - 1 : null
}

/** ⌃Tab / ⌃⇧Tab: the next or previous tab, wrapping around. */
export function cycleTabIndex(count: number, current: number, direction: 'next' | 'previous'): number | null {
  if (count < 2 || current < 0 || current >= count) return null
  return direction === 'next' ? (current + 1) % count : (current - 1 + count) % count
}

export function nextTabIndex(count: number, current: number, key: string): number | null {
  if (count < 1 || current < 0 || current >= count) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight') return (current + 1) % count
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  return null
}

export function moveHistory(tabs: SavedTabs, direction: 'back' | 'forward'): SavedTabs {
  const tab = tabs.items[tabs.active]
  if (!tab) return tabs
  const index = tab.index + (direction === 'back' ? -1 : 1)
  if (index < 0 || index >= tab.entries.length) return tabs
  const items = tabs.items.map((item, itemIndex) => itemIndex === tabs.active ? { ...item, index } : item)
  return { items, active: tabs.active }
}

export function activeHref(tabs: SavedTabs): string {
  const tab = tabs.items[tabs.active]
  return tab?.entries[tab.index] ?? '/'
}

const SECTION_TAB_LABELS: Record<string, string> = {
  threads: 'Threads',
  tasks: 'Tasks',
  issues: 'Tasks',
  board: 'Tasks',
  projects: 'Projects',
  'team-projects': 'Projects',
  pulls: 'Pulls',
  suggestions: 'Inbox',
  inbox: 'Inbox',
  plugins: 'Plugins',
  connections: 'Plugins',
  mcp: 'Plugins',
  automations: 'Automations',
  artifacts: 'Artifacts',
  files: 'Artifacts',
  memory: 'Memory',
  chat: 'Chat',
}

const SEGMENT_TAB_LABELS: Record<string, string> = {
  dashboard: 'Home',
  settings: 'Settings',
  devices: 'Devices',
  teams: 'Teams',
  members: 'Members',
  tasks: 'Tasks',
  projects: 'Projects',
  pulls: 'Pulls',
  plugins: 'Plugins',
  automations: 'Automations',
  artifacts: 'Artifacts',
  inbox: 'Inbox',
  threads: 'Threads',
  memory: 'Memory',
}

export function tabLabel(href: string): string {
  try {
    const url = new URL(href, 'https://mikka.invalid')
    const path = url.pathname.replace(/^\/mikka(?=\/|$)/, '').replace(/^\/(?:en|zh-CN)(?=\/|$)/, '')
    const segments = path.split('/').filter(Boolean)
    if (url.searchParams.has('issue')) return 'Task'
    if (segments[0] === 'tasks' && segments.length > 1) return 'Task'
    if (url.searchParams.has('mainThread') || (segments[0] === 'threads' && segments.length > 1)) return 'Thread'
    if (url.searchParams.has('group')) return 'Group'
    if (url.searchParams.has('bot')) return 'Chat'
    if (segments[0] === 'settings') {
      const section = segments[1] ?? url.searchParams.get('section')
      if (section === 'devices') return 'Devices'
      if (section === 'members') return 'Members'
      if (section === 'teams') return 'Teams'
      return 'Settings'
    }
    if (segments.length === 0 || segments[0] === 'dashboard') {
      const section = url.searchParams.get('section')
      if (section && Object.hasOwn(SECTION_TAB_LABELS, section)) return SECTION_TAB_LABELS[section]!
      return 'Home'
    }
    const segment = segments[segments.length - 1] ?? 'Home'
    if (Object.hasOwn(SEGMENT_TAB_LABELS, segment)) return SEGMENT_TAB_LABELS[segment]!
    return decodeURIComponent(segment).replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()).slice(0, 24)
  } catch {
    return 'Mikka'
  }
}
