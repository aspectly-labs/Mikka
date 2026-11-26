/**
 * Settings sections and item-level backend availability. Groups (resolved-settings R-S06, 2026-11-25):
 * 个人 · an untitled connections & compute group · Agent · 工作区 (as Capy's).
 * The sidebar, URL parsing and the page bodies all read this single source of truth.
 */
export type SettingsGroup = 'personal' | 'compute' | 'agent' | 'review' | 'workspace'

/** `compute` has no title in the sidebar, only a divider (Capy, Cursor, Devin). */
export const SETTINGS_GROUPS = ['personal', 'compute', 'agent', 'review', 'workspace'] as const satisfies readonly SettingsGroup[]

export type SettingsSectionId =
  | 'preferences' | 'appearance' | 'account' | 'security' | 'notifications' | 'shortcuts' | 'privacy'
  | 'models' | 'environments' | 'mcp' | 'connections' | 'integrations' | 'developer' | 'secrets' | 'logins' | 'computers'
  | 'instructions' | 'team-skills' | 'threads' | 'git' | 'agent-configs' | 'agent-permissions' | 'memory'
  | 'identity'
  | 'review-repositories' | 'review-config'
  | 'general' | 'organization' | 'issue-states' | 'members' | 'teams'
  | 'billing' | 'usage' | 'activity' | 'permissions' | 'audit' | 'cloud'
  | 'referrals' | 'experiments' | 'cloud-credentials'

/**
 * Three-tier display rule (#3118):
 * - `available`: live backend, rendered normally.
 * - `pending`: backend not wired yet; sidebar pages stay unexposed until built, and in-page items append `· 待接入` and stay disabled.
 * - `skipped`: explicitly omitted ("不做" or UI-only proposal); centrally hidden with zero links.
 */
export type SettingAvailability = 'available' | 'pending' | 'skipped'

export const SETTINGS_SECTION_STATUS: Readonly<Record<SettingsSectionId, SettingAvailability>> = {
  preferences: 'available',
  appearance: 'available',
  account: 'available',
  security: 'available',
  notifications: 'available',
  shortcuts: 'available',
  privacy: 'available',
  models: 'available',
  environments: 'available',
  mcp: 'available',
  connections: 'available',
  integrations: 'available',
  developer: 'available',
  secrets: 'available',
  logins: 'available',
  computers: 'available',
  instructions: 'available',
  'team-skills': 'available',
  threads: 'available',
  git: 'available',
  'agent-configs': 'available',
  'agent-permissions': 'available',
  memory: 'available',
  'review-repositories': 'skipped',
  'review-config': 'skipped',
  general: 'available',
  identity: 'available',
  organization: 'available',
  'issue-states': 'available',
  members: 'available',
  teams: 'available',
  billing: 'available',
  usage: 'available',
  activity: 'available',
  permissions: 'available',
  audit: 'available',
  cloud: 'available',
  referrals: 'skipped',
  experiments: 'skipped',
  'cloud-credentials': 'skipped',
}

export type SettingItemId =
  | 'appearance.sync'
  | 'appearance.colorScheme'
  | 'appearance.theme'
  | 'appearance.myThemes'
  | 'appearance.colors'
  | 'appearance.dashboardBackground'
  | 'appearance.backgroundEffect'
  | 'appearance.codeFontSize'
  | 'appearance.diffView'
  | 'appearance.diffColors'
  | 'appearance.hiddenFiles'
  | 'shortcuts.customizeBindings'
  | 'environments.networkAccess'
  | 'threads.subagentMaxConcurrent'
  | 'threads.subagentDepth'
  | 'workspace.newWorkVisibility'
  | 'workspace.workVisibility'
  | 'workspace.allowPrivate'

export const SETTINGS_ITEM_STATUS: Readonly<Record<SettingItemId, SettingAvailability>> = {
  'appearance.sync': 'available',
  'appearance.colorScheme': 'available',
  'appearance.theme': 'available',
  'appearance.myThemes': 'skipped',
  'appearance.colors': 'available',
  'appearance.dashboardBackground': 'skipped',
  'appearance.backgroundEffect': 'available',
  'appearance.codeFontSize': 'available',
  'appearance.diffView': 'available',
  'appearance.diffColors': 'available',
  'appearance.hiddenFiles': 'available',
  'shortcuts.customizeBindings': 'available',
  'environments.networkAccess': 'available',
  'threads.subagentMaxConcurrent': 'available',
  'threads.subagentDepth': 'skipped',
  'workspace.newWorkVisibility': 'available',
  'workspace.workVisibility': 'available',
  'workspace.allowPrivate': 'available',
}

export function settingSectionStatus(id: SettingsSectionId): SettingAvailability {
  return SETTINGS_SECTION_STATUS[id]
}

export function settingItemStatus(id: SettingItemId): SettingAvailability {
  return SETTINGS_ITEM_STATUS[id]
}

export function settingItemShown(id: SettingItemId): boolean {
  return SETTINGS_ITEM_STATUS[id] !== 'skipped'
}

export function settingItemPending(id: SettingItemId): boolean {
  return SETTINGS_ITEM_STATUS[id] === 'pending'
}

export function withPendingSuffix(label: string, pendingTag: string): string {
  return `${label} · ${pendingTag}`
}

/** Wide table pages (#3118 frames 08/10/25/27/28/29/37): 776px content column instead of 564px. */
export const WIDE_SETTINGS_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  'shortcuts',
  'environments',
  'members',
  'teams',
  'usage',
  'activity',
  'audit',
])

export interface SettingsSectionDef {
  id: SettingsSectionId
  group: SettingsGroup
  /** English name; the sidebar search matches it in any locale. */
  title: string
  /** Hidden from members. The server still checks the role. */
  adminOnly?: boolean
  /** Has its own route instead of `?section=`. */
  routed?: boolean
  /** No page body yet (`SETTINGS_SECTION_STATUS[id] === 'pending'`). */
  unbuilt?: true
  /** Omitted (`SETTINGS_SECTION_STATUS[id] === 'skipped'`). Not a link. */
  withheld?: true
  /** Reachable by an old or direct URL, not listed in the sidebar. */
  sidebar?: false
}

const RAW_SECTIONS: readonly Omit<SettingsSectionDef, 'unbuilt' | 'withheld'>[] = [
  // Personal (account-scoped)
  { id: 'preferences', group: 'personal', title: 'General' },
  { id: 'appearance', group: 'personal', title: 'Appearance' },
  { id: 'account', group: 'personal', title: 'Profile' },
  { id: 'security', group: 'personal', title: 'Security' },
  { id: 'notifications', group: 'personal', title: 'Notifications' },
  { id: 'shortcuts', group: 'personal', title: 'Shortcuts' },
  // R-S05: export, shared links, archived threads (ChatGPT Data controls, Claude Privacy, Codex Data & Privacy).
  { id: 'privacy', group: 'personal', title: 'Data and privacy' },
  // Personal secrets stay one click from an old link; the sidebar entry is Secrets & Credentials.
  { id: 'logins', group: 'personal', title: 'Secrets and logins', sidebar: false },
  // Connections & compute: no group title (R-S06; Capy's untitled rows, Cursor's and Devin's dividers).
  { id: 'models', group: 'compute', title: 'Models and subscriptions' },
  { id: 'environments', group: 'compute', title: 'Cloud environments' },
  { id: 'computers', group: 'compute', title: 'Devices' },
  { id: 'secrets', group: 'compute', title: 'Secrets & Credentials' },
  // R-S19: accounts Mikka talks through (GitHub, Linear, Slack, Telegram) apart from the tools an Agent calls.
  { id: 'integrations', group: 'compute', title: 'Integrations' },
  { id: 'connections', group: 'compute', title: 'Connectors and MCP' },
  // Direct `?section=mcp` links open 连接器与 MCP on its Custom MCP tab.
  { id: 'mcp', group: 'compute', title: 'Custom MCP', sidebar: false },
  // API keys act as you or a service account (Capy lists API with the connections).
  { id: 'developer', group: 'compute', title: 'API' },
  // Agent
  { id: 'instructions', group: 'agent', title: 'Instructions' },
  { id: 'team-skills', group: 'agent', title: 'Skills' },
  { id: 'threads', group: 'agent', title: 'Threads' },
  { id: 'git', group: 'agent', title: 'Git and pull requests' },
  // R-S20: tasks and Bots both pick one, so it is its own entry, not part of 指令.
  { id: 'agent-configs', group: 'agent', title: 'Agent configurations' },
  // R-S25: approval policy and templates (Codex Configuration, Claude Code permissions).
  { id: 'agent-permissions', group: 'agent', title: 'Agent permissions', adminOnly: true },
  { id: 'memory', group: 'agent', title: 'Memory' },
  // Review (withheld)
  { id: 'review-repositories', group: 'review', title: 'Review repositories' },
  { id: 'review-config', group: 'review', title: 'Review config' },
  // Workspace (team / workspace administration, activity, billing, identity)
  { id: 'general', group: 'workspace', title: 'Workspace general' },
  // R-S27: domains, single sign-on, required two-step verification (Capy's order: right after General).
  { id: 'identity', group: 'workspace', title: 'Identity and access', adminOnly: true },
  { id: 'issue-states', group: 'workspace', title: 'Task states' },
  { id: 'members', group: 'workspace', title: 'Members', routed: true },
  { id: 'teams', group: 'workspace', title: 'Teams', routed: true },
  // R-S02: 团队权限 is gone; each policy sits on the page of what it controls. Old links open Agent 权限.
  { id: 'permissions', group: 'workspace', title: 'Team permissions', adminOnly: true, sidebar: false },
  { id: 'billing', group: 'workspace', title: 'Billing' },
  { id: 'usage', group: 'workspace', title: 'Usage' },
  { id: 'activity', group: 'workspace', title: 'Activity' },
  { id: 'audit', group: 'workspace', title: 'Audit log', adminOnly: true },
  // R-S01: shown only once the workspace is bound to an organization or on the enterprise plan.
  { id: 'organization', group: 'workspace', title: 'Organization' },
  { id: 'cloud', group: 'workspace', title: 'Mikka Cloud' },
  { id: 'referrals', group: 'personal', title: 'Referrals' },
  { id: 'experiments', group: 'personal', title: 'Experiments' },
  { id: 'cloud-credentials', group: 'personal', title: 'Cloud credentials' },
]

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = RAW_SECTIONS.map(section => {
  const status = SETTINGS_SECTION_STATUS[section.id]
  return {
    ...section,
    ...(status === 'pending' ? { unbuilt: true as const } : {}),
    ...(status === 'skipped' ? { withheld: true as const } : {}),
  }
})

/** Section ids from before the four groups. Old links open the page that now holds the content. */
const LEGACY: Record<string, SettingsSectionId> = {
  profile: 'account',
  devices: 'computers',
  workspace: 'general',
  bots: 'models',
}

/**
 * What only a team has: what is between people (decision 2026-11-02-0203). A
 * personal workspace has every setting of the workspace itself and none of these.
 */
export const TEAM_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['organization', 'members', 'teams', 'permissions', 'audit', 'identity'])

export type SettingsVisibility = {
  admin: boolean
  personal?: boolean
  billing?: boolean
  cloudAdmin?: boolean
  /** A UI layer draws 组织. */
  organization?: boolean
  /** Accepted by hosted sidebar callers for memory-gate compatibility. */
  memory?: boolean
}

/** One place decides whether a section is listed. The sidebar and search both ask this. */
export function settingsSectionShown(section: SettingsSectionDef, { admin, personal = false, billing = true, cloudAdmin = false, organization = true, memory = false }: SettingsVisibility): boolean {
  if (SETTINGS_SECTION_STATUS[section.id] !== 'available' || section.sidebar === false) return false
  if (section.adminOnly && !admin) return false
  if (personal && TEAM_ONLY_SECTIONS.has(section.id)) return false
  if (!organization && section.id === 'organization') return false
  if (!billing && section.id === 'billing') return false
  if (!cloudAdmin && section.id === 'cloud') return false
  if (!memory && section.id === 'memory') return false
  return true
}

const openable = new Set<string>(SETTINGS_SECTIONS.filter(s => SETTINGS_SECTION_STATUS[s.id] === 'available').map(s => s.id))
const known = new Set<string>(SETTINGS_SECTIONS.filter(s => SETTINGS_SECTION_STATUS[s.id] !== 'skipped').map(s => s.id))

/** True for any `?section=` value settings can open: available, pending (falls back to 常规) or legacy. Skipped ids are not links. */
export function isSettingsSectionParam(section: string): boolean {
  return known.has(section) || Object.hasOwn(LEGACY, section)
}

/** The section a settings URL shows. `/settings/members` and `/settings/teams` win over `?section=`. */
export function resolveSettingsSection(pathname: string, section: string | null | undefined): SettingsSectionId {
  if (pathname.endsWith('/settings/members')) return 'members'
  if (pathname.endsWith('/settings/teams')) return 'teams'
  // 团队权限's policies moved (R-S02); an old link opens Agent 权限, which holds its templates.
  if (section === 'permissions') return 'agent-permissions'
  if (section && openable.has(section)) return section as SettingsSectionId
  if (section && Object.hasOwn(LEGACY, section)) return LEGACY[section]
  return 'preferences'
}

export function settingsHref(id: SettingsSectionId, workspaceId?: string, params?: Record<string, string | undefined>): string {
  const def = SETTINGS_SECTIONS.find(s => s.id === id)
  const search = new URLSearchParams(workspaceId ? { workspace: workspaceId } : {})
  if (!def?.routed) search.set('section', id)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, value)
    }
  }
  if (def?.routed) return `/settings/${id}${search.size ? `?${search}` : ''}`
  return `/settings?${search}`
}

export function visibleSettingsSections(ctx: SettingsVisibility): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter(section => settingsSectionShown(section, ctx))
}
