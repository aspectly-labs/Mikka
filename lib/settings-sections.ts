/**
 * Settings sections and item-level backend availability, in the order of
 * 2026-11-21 Figma page 1508:2 (Capy's four groups).
 * The sidebar, URL parsing and the page bodies all read this single source of truth.
 */
export type SettingsGroup = 'personal' | 'agent' | 'review' | 'workspace'

export const SETTINGS_GROUPS = ['personal', 'agent', 'review', 'workspace'] as const satisfies readonly SettingsGroup[]

export type SettingsSectionId =
  | 'preferences' | 'appearance' | 'account' | 'security' | 'notifications' | 'shortcuts'
  | 'models' | 'environments' | 'mcp' | 'connections' | 'developer' | 'secrets' | 'logins' | 'computers'
  | 'instructions' | 'team-skills' | 'threads' | 'git' | 'memory'
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
  models: 'available',
  environments: 'available',
  mcp: 'available',
  connections: 'available',
  developer: 'available',
  secrets: 'available',
  logins: 'available',
  computers: 'available',
  instructions: 'available',
  'team-skills': 'available',
  threads: 'available',
  git: 'available',
  memory: 'available',
  'review-repositories': 'skipped',
  'review-config': 'skipped',
  general: 'available',
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
  'appearance.myThemes': 'pending',
  'appearance.colors': 'available',
  'appearance.dashboardBackground': 'pending',
  'appearance.backgroundEffect': 'available',
  'appearance.codeFontSize': 'available',
  'appearance.diffView': 'available',
  'appearance.diffColors': 'available',
  'appearance.hiddenFiles': 'available',
  'environments.networkAccess': 'skipped',
  'threads.subagentMaxConcurrent': 'available',
  'threads.subagentDepth': 'pending',
  'workspace.newWorkVisibility': 'pending',
  'workspace.workVisibility': 'pending',
  'workspace.allowPrivate': 'pending',
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
  { id: 'preferences', group: 'personal', title: 'General' },
  { id: 'appearance', group: 'personal', title: 'Appearance' },
  { id: 'account', group: 'personal', title: 'Profile' },
  { id: 'security', group: 'personal', title: 'Security' },
  { id: 'notifications', group: 'personal', title: 'Notifications' },
  { id: 'shortcuts', group: 'personal', title: 'Shortcuts' },
  { id: 'models', group: 'personal', title: 'Models and subscriptions' },
  { id: 'environments', group: 'personal', title: 'Run environments' },
  { id: 'mcp', group: 'personal', title: 'MCP and plugins' },
  { id: 'connections', group: 'personal', title: 'Integrations' },
  { id: 'developer', group: 'personal', title: 'Personal access tokens' },
  { id: 'secrets', group: 'personal', title: 'Secrets and environment' },
  // Personal secrets stay one click from an old link; the sidebar entry is 密钥与环境.
  { id: 'logins', group: 'personal', title: 'Secrets and logins', sidebar: false },
  { id: 'computers', group: 'personal', title: 'Devices' },
  { id: 'instructions', group: 'agent', title: 'Instructions' },
  { id: 'team-skills', group: 'agent', title: 'Skills' },
  { id: 'threads', group: 'agent', title: 'Threads' },
  { id: 'git', group: 'agent', title: 'Git and pull requests' },
  { id: 'memory', group: 'agent', title: 'Memory' },
  { id: 'review-repositories', group: 'review', title: 'Review repositories' },
  { id: 'review-config', group: 'review', title: 'Review config' },
  { id: 'general', group: 'workspace', title: 'Workspace general' },
  { id: 'organization', group: 'workspace', title: 'Organization' },
  { id: 'issue-states', group: 'workspace', title: 'Issue states' },
  { id: 'members', group: 'workspace', title: 'Members', routed: true },
  { id: 'teams', group: 'workspace', title: 'Teams', routed: true },
  { id: 'billing', group: 'workspace', title: 'Billing' },
  { id: 'usage', group: 'workspace', title: 'Usage' },
  { id: 'activity', group: 'workspace', title: 'Activity' },
  { id: 'permissions', group: 'workspace', title: 'Team permissions', adminOnly: true, sidebar: false },
  { id: 'audit', group: 'workspace', title: 'Audit log', adminOnly: true },
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
  integrations: 'connections',
  devices: 'computers',
  workspace: 'general',
  bots: 'models',
  privacy: 'account',
}

/**
 * What only a team has: what is between people (decision 2026-11-02-0203). A
 * personal workspace has every setting of the workspace itself and none of these.
 */
export const TEAM_ONLY_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(['organization', 'members', 'teams', 'permissions', 'audit'])

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
export function settingsSectionShown(section: SettingsSectionDef, { admin, personal = false, billing = true, cloudAdmin = false }: SettingsVisibility): boolean {
  if (SETTINGS_SECTION_STATUS[section.id] !== 'available' || section.sidebar === false) return false
  if (section.adminOnly && !admin) return false
  if (personal && TEAM_ONLY_SECTIONS.has(section.id)) return false
  if (!billing && section.id === 'billing') return false
  if (!cloudAdmin && section.id === 'cloud') return false
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
  if (section && openable.has(section)) return section as SettingsSectionId
  if (section && Object.hasOwn(LEGACY, section)) return LEGACY[section]
  return 'preferences'
}

export function settingsHref(id: SettingsSectionId, workspaceId?: string): string {
  const def = SETTINGS_SECTIONS.find(s => s.id === id)
  const search = new URLSearchParams(workspaceId ? { workspace: workspaceId } : {})
  if (def?.routed) return `/settings/${id}${search.size ? `?${search}` : ''}`
  search.set('section', id)
  return `/settings?${search}`
}

export function visibleSettingsSections(ctx: SettingsVisibility): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter(section => settingsSectionShown(section, ctx))
}
