/**
 * Pure workspace URL builders, location parsers, and history-mark helpers
 * shared across server links, notifications, mobile targets, and web navigation
 * (rules.md R-82, decisions/2026-11-01-1320-navigation-model.md).
 */
export type WorkspaceSection = 'pulls' | 'conversations' | 'inbox' | 'my-issues' | 'agent' | 'coordinator' | 'group' | 'projects' | 'views' | 'team-home' | 'team-issues' | 'team-projects' | 'all-issues' | 'plugins' | 'suggestions' | 'artifacts' | 'memory' | 'automations'

export const SECTION_TITLE_KEYS: Record<WorkspaceSection, string> = {
  conversations: 'Nav.conversations',
  pulls: 'ArtifactsPage.category.pullRequests',
  inbox: 'Nav.inbox',
  'my-issues': 'Nav.myTasks',
  agent: 'Nav.agent',
  coordinator: 'Nav.coordinator',
  group: 'GroupChat.untitled',
  projects: 'Nav.projects',
  views: 'Nav.views',
  'team-home': 'Nav.teamHome',
  'team-issues': 'Nav.tasks',
  'team-projects': 'Nav.projects',
  'all-issues': 'Nav.allIssues',
  plugins: 'Nav.plugins',
  suggestions: 'Nav.suggestions',
  artifacts: 'Nav.artifacts',
  memory: 'HostedSettings.memory.title',
  automations: 'Automations.title',
}

/** Sections a reload or a shared link reopens; the others start from their parent page. The Coordinator's chat is the default and needs none. */
const URL_SECTIONS = ['pulls', 'conversations', 'agent', 'plugins', 'suggestions', 'artifacts', 'memory', 'automations', 'all-issues', 'projects'] as const satisfies readonly WorkspaceSection[]
const READ_SECTIONS: readonly string[] = [...URL_SECTIONS, 'coordinator']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Query keys that belong to a page inside a section (the plugins page's app and category, an open automation, a PR's own page); a new place drops them. */
const PAGE_KEYS = ['app', 'category', 'automation', 'pull'] as const

/** The retired 任务 page's address. Tasks have one entry, the board (2026-11-13-1405): an old link opens it in its list view. */
export const LEGACY_TASKS_SECTION = 'tasks'

export function sectionFromQuery(section: string | undefined): WorkspaceSection {
  if (section === LEGACY_TASKS_SECTION) return 'all-issues'
  return READ_SECTIONS.includes(section ?? '') ? section as WorkspaceSection : 'coordinator'
}

export function writeSectionQuery(params: URLSearchParams, section: WorkspaceSection): void {
  if (URL_SECTIONS.some(item => item === section)) params.set('section', section)
  else params.delete('section')
}

/** What the address says is on screen. */
export type WorkspaceLocation = {
  section: WorkspaceSection
  /** The bot whose chat is in the centre; null for the Coordinator. */
  bot: string | null
  /** Optional Bot filter for the conversation directory. */
  directoryBot?: string | null
  /** 查看运行: the thread directory filtered to one automation's runs (`directoryAutomation=<id>`; `automation` is the editor's). */
  directoryAutomation?: string | null
  /** The group chat in the centre (`group=<id>`; its section is implied). */
  group: string | null
  /** The saved chat in the centre (`section=agent&session=<id>`); null opens the latest. */
  session: string | null
  /** The team whose page is in the centre; its 主页 is `team=<id>` alone. */
  team: string | null
  /** The project open on the projects page. */
  project: string | null
  /** The task open in the centre. */
  issue: string | null
  /** The run open as the main conversation from the Bot sidebar. */
  mainThread?: string | null
  /** The task open in the right column, beside whatever is in the centre (decision 2026-11-07-2045): a thread opened from it sits over it, and ← comes back to it. */
  task: string | null
  /** The thread (its run id) open in the right column, beside whatever is in the centre (R-82). */
  thread: string | null
  /** The Artifact open in its window over the page (R-56, R-82). */
  artifact: string | null
  /** 全部线程 in the right column: 'all', or one bot's id when filtered to it. It stays open as the centre changes. */
  threads: string | null
}

/** Team pages, under 看板 (R-82); each needs its team. */
const TEAM_SECTIONS: readonly string[] = ['team-home', 'team-issues', 'team-projects'] satisfies readonly WorkspaceSection[]
/** Pages that can show one project. */
const PROJECT_SECTIONS: readonly string[] = ['projects', 'team-projects'] satisfies readonly WorkspaceSection[]
/** Keys this file owns besides `section`, in the order a new address writes them. */
const PLACE_KEYS = ['bot', 'directoryBot', 'directoryAutomation', 'group', 'session', 'team', 'project', 'issue', 'mainThread', 'task', 'thread', 'artifact', 'threads'] as const satisfies readonly (keyof WorkspaceLocation)[]
/** What is in the centre; the thread sits beside it and the Artifact window over it. */
const CENTRE_KEYS = ['section', 'bot', 'directoryBot', 'directoryAutomation', 'group', 'session', 'team', 'project', 'issue', 'mainThread'] as const satisfies readonly (keyof WorkspaceLocation)[]

/** A team page without a team is the workspace-wide page it would scope. */
export function sectionFor(section: WorkspaceSection, team: string | null): WorkspaceSection {
  if (!TEAM_SECTIONS.includes(section) || team) return section
  return section === 'team-projects' ? 'projects' : section === 'team-issues' ? 'all-issues' : 'coordinator'
}

export function readLocation(params: URLSearchParams): WorkspaceLocation {
  const id = (key: string) => { const value = params.get(key); return value && UUID.test(value) ? value : null }
  const asked = params.get('section') ?? undefined
  const team = id('team')
  let section = sectionFromQuery(asked)
  if (team && (asked === undefined || TEAM_SECTIONS.includes(asked))) section = (asked ?? 'team-home') as WorkspaceSection
  else if (section === 'coordinator' && id('group')) section = 'group'
  return {
    section,
    ...(section === 'conversations' && id('directoryBot') ? { directoryBot: id('directoryBot') } : {}),
    ...(section === 'conversations' && id('directoryAutomation') ? { directoryAutomation: id('directoryAutomation') } : {}),
    bot: section === 'coordinator' ? id('bot') : null,
    group: section === 'group' ? id('group') : null,
    session: section === 'agent' ? id('session') : null,
    team: TEAM_SECTIONS.includes(section) ? team : null,
    project: PROJECT_SECTIONS.includes(section) ? id('project') : null,
    issue: id('issue'),
    ...(section === 'coordinator' && !id('issue') && id('mainThread') ? { mainThread: id('mainThread') } : {}),
    task: id('task'),
    thread: id('thread'),
    artifact: id('artifact'),
    threads: params.get('threads') === 'all' ? 'all' : id('threads'),
  }
}

export function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation) {
  return a.section === b.section && PLACE_KEYS.every(key => a[key] === b[key])
}

/**
 * Where a task page was opened from, when its address names it: a bot's chat
 * (`bot=`), the Coordinator's chat (`section=coordinator`), the board or
 * another page (`section=`). Null for a bare `?issue=` link.
 */
export type TaskOrigin = { section: WorkspaceSection; bot: string | null }

export function taskOrigin(params: URLSearchParams): TaskOrigin | null {
  const location = readLocation(params)
  if (location.bot) return { section: 'coordinator', bot: location.bot }
  return READ_SECTIONS.includes(params.get('section') ?? '') ? { section: location.section, bot: null } : null
}

function buildHref(current: URL, change: Partial<WorkspaceLocation>, nameCoordinator: boolean): string {
  const url = new URL(current.href)
  const params = url.searchParams
  const before = readLocation(params)
  const named = params.get('section') === 'coordinator'
  const next = { ...before, ...change }
  next.section = sectionFor(next.section, next.team)
  if (next.section !== 'conversations') { delete next.directoryBot; delete next.directoryAutomation }
  if (next.section !== 'coordinator') next.bot = null
  if (next.section !== 'group') next.group = null
  if (next.section !== 'agent') next.session = null
  if (!TEAM_SECTIONS.includes(next.section)) next.team = null
  if (!PROJECT_SECTIONS.includes(next.section)) next.project = null
  if (next.section !== 'coordinator' || next.issue || (next.bot !== before.bot && !('mainThread' in change))) next.mainThread = null
  const centreMoved = CENTRE_KEYS.some(key => next[key] !== before[key])
  // A thread sits beside the centre it was opened from; a new centre closes it unless the move names one.
  if (centreMoved && !('thread' in change)) next.thread = null
  // So does a task opened beside it.
  if (centreMoved && !('task' in change)) next.task = null
  // The Artifact window sits over the page it was opened from: another place, or another thread, closes it unless the move names one.
  if ((centreMoved || next.thread !== before.thread) && !('artifact' in change)) next.artifact = null
  if (next.section !== before.section || next.bot !== before.bot) for (const key of PAGE_KEYS) params.delete(key)
  // A task opened from the Coordinator's chat says so (a bare `?issue=` is a plain link), so ✕ and its first crumb return there.
  // A team page reads as its team, so it names no chat.
  if (next.issue && next.section === 'coordinator' && !next.bot && (named || (nameCoordinator && !before.issue && !next.team))) params.set('section', 'coordinator')
  else writeSectionQuery(params, next.section)
  if (next.team && next.section !== 'team-home') params.set('section', next.section)
  for (const key of PLACE_KEYS) {
    const value = next[key]
    if (value) params.set(key, value)
    else params.delete(key)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

/** The address with `change` applied to `current`; query keys this file does not own are kept. */
export function workspaceHref(current: URL, change: Partial<WorkspaceLocation>): string {
  return buildHref(current, change, true)
}

/** The query for a place, built from nothing (a link to copy, a notification, a server redirect). */
export function workspaceSearch(place: Partial<WorkspaceLocation>): string {
  const href = buildHref(new URL('https://mikka.invalid/'), place, place.section === 'coordinator')
  return href.slice(1)
}

/** An app-root link to a place, e.g. `/?issue=<id>`; prefix the base path and locale where the caller needs them. */
export function workspaceLink(place: Partial<WorkspaceLocation>): string {
  return `/${workspaceSearch(place)}`
}

/** Open one existing rail destination in an explicitly selected tenant. */
export function workspaceSectionLink(section: WorkspaceSection, workspaceId: string): string {
  const link = new URL(workspaceLink({ section }), 'https://mikka.invalid')
  link.searchParams.set('workspace', workspaceId)
  return link.pathname + link.search
}

/**
 * The address as the workspace shows it: an unknown `section`, a `bot` that
 * is not one of the person's bots (`botExists`, once the list has loaded) and
 * keys that are not ids drop out.
 */
export function canonicalHref(current: URL, botExists?: (id: string) => boolean): string {
  const location = readLocation(current.searchParams)
  if (location.bot && botExists && !botExists(location.bot)) location.bot = null
  return workspaceHref(current, location)
}

/**
 * Each entry the workspace writes carries a mark in history.state beside
 * any keys already there (older pages left Next's `__NA`, copied, never
 * replaced): its position and, on a task page, the entry that opened it. ✕
 * steps back there when that entry belongs to this page load (`doc`), so the
 * chat comes back as it was; a pasted link, a reload or a cold start has no
 * such entry and goes to the address's origin instead.
 */
export type EntryMark = { index: number; task: { start: number; doc: string; list: boolean } | null }
const MARK = 'mikkaEntry'

export function readMark(state: unknown): EntryMark | null {
  const mark = state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : null
  if (!mark || typeof mark !== 'object') return null
  const { index, task } = mark as Partial<EntryMark>
  if (typeof index !== 'number') return null
  return { index, task: task && typeof task.start === 'number' && typeof task.doc === 'string' ? { start: task.start, doc: task.doc, list: task.list === true } : null }
}

/** The mark for the entry written after `previous`. A task opened from a place starts its own; a move inside it (a thread, ↑↓, a sub-task) keeps the one it started with. */
export function nextMark(previous: EntryMark | null, from: string | null, to: string | null, mode: 'push' | 'replace', doc: string, list: boolean): EntryMark {
  const base = previous ?? { index: 0, task: null }
  const index = mode === 'push' ? base.index + 1 : base.index
  if (!to) return { index, task: null }
  if (from) return { index, task: base.task }
  return { index, task: { start: index, doc, list } }
}

/** How many entries back the place that opened this task is, in this page load; 0 when it was opened directly. */
export function stepsToOrigin(mark: EntryMark | null, doc: string): number {
  const task = mark?.task
  return mark && task && task.doc === doc && task.start >= 1 ? mark.index - task.start + 1 : 0
}
