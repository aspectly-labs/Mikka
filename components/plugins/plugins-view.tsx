'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import useSWRInfinite from 'swr/infinite'
import {
  Blocks,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FolderGit2,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/icons'
import { getLinearIntegrationState } from '@/app/actions/linear-sync'
import { getTelegramIntegrationStatus } from '@/app/actions/telegram'
import { APP_ICONS } from '@/components/plugins/app-icons'
import {
  AppTile,
  ConnectedAppDetail,
  OWN_APPS,
  isOwnApp,
  useAppInfo,
  useConnectedApps,
  useStoreCatalog,
  type ConnectedApps,
  type OwnAppId,
} from '@/components/plugins/connected-apps'
import { OwnAppsStatus, type OwnAppState, type OwnAppStates, type OwnAppsRead } from '@/components/plugins/connected-list'
import type { CredentialTarget } from '@/components/plugins/credential-dialog'
import { GitHubSettings } from '@/components/plugins/github-settings'
import { readMcpConnections, useMcpConnections } from '@/components/plugins/mcp-connections'
import { mcpServerInput, type McpCreateInput, type McpServerDraft } from '@/components/plugins/mcp-server-draft'
import { useSlackInstallation } from '@/components/plugins/slack-installation'
import { IconTile } from '@/components/reui/icon-tile'
import { LinearSettings } from '@/components/settings/linear-settings'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { TelegramSettings } from '@/components/settings/telegram-settings'
import { PluginsPage } from '@ui-slot/plugins'
import { AppPage, ConnectionsList } from '@ui-slot/settings-connections'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SearchInput } from '@/components/ui/search-input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { goToHref, workspaceLink } from '@/components/workspace/workspace-navigation'
import { Link } from '@/i18n/navigation'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import { appState } from '@/lib/composio-account-state'
import { isToolkitSlug } from '@/lib/composio-accounts'
import { useViewState } from '@/lib/hooks/view-state'
import { useTranslations } from '@/lib/intl/i18n-client'
import { findCredentialAlternative, type StoreApp } from '@/lib/plugins/catalog'
import type { ConnectKind } from '@/lib/plugins/connect-kind'
import type { InstalledSkill, McpServerView, McpWorkspaceServerView } from '@/lib/plugins/contracts'
import { matchesStoreQuery, storeItemState, type StoreItemState } from '@/lib/plugins/store-state'
import { settingsReadOptions } from '@/lib/settings-data'
import type { SkillsSearchResult } from '@/lib/skills-search'
import { ReadResponseError } from '@/lib/swr/retry'
import { cn } from '@/lib/utils'

export const OWN_APP_STATES_KEY = 'plugin-own-app-states'
/** Items a section shows before its ›. */
const SECTION_PREVIEW = 6
const CATEGORY_PREVIEW = 4
const TOOL_PREVIEW_COUNT = 5

const SKILL_SOURCE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/
const SKILL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const noRefocusRead = { ...settingsReadOptions, revalidateOnFocus: false } as const

type SkillsPage = { data: SkillsSearchResult[]; hasMore: boolean }

async function fetchSkills([path, query, page]: readonly [string, string, number]): Promise<SkillsPage> {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (page) params.set('page', String(page))
  const search = params.toString()
  const response = await fetch(withBasePath(search ? path + '?' + search : path))
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(failure?.error ?? 'skills_search_failed')
  }
  return await response.json() as SkillsPage
}

/** An own app's status read failed: a stable code with the cause's kind, never its message (decision 2026-11-05-0330). */
class OwnAppReadError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = 'OwnAppReadError' }
}
const httpDetail = (response: Response) => `http_${response.status ?? 'unknown'}`

/** The flag service (PostHog) did not answer: not this person's problem, and not ours to report. */
const FLAG_UNREADABLE = Symbol('flag unreadable')

/** A successful null means not configured; a failed read of our own endpoints rejects instead. */
async function fetchOwnAppState(id: OwnAppId): Promise<OwnAppState | typeof FLAG_UNREADABLE> {
  if (id === 'github') {
    const response = await fetch(withBasePath('/api/integrations/github'), { cache: 'no-store' })
    if (!response.ok) throw new OwnAppReadError(`github_status_failed (${httpDetail(response)})`)
    const state = await response.json() as { configured: boolean; connected: boolean; installed: boolean }
    return !state.configured ? null : state.connected && state.installed ? 'connected' : 'notConnected'
  }
  if (id === 'linear') {
    const response = await fetch(withBasePath('/api/integrations/linear/status'), { cache: 'no-store' })
    if (!response.ok) throw new OwnAppReadError(`linear_status_failed (${httpDetail(response)})`)
    const availability = await response.json() as { enabled?: boolean; state?: string }
    if (typeof availability.enabled !== 'boolean') throw new OwnAppReadError('linear_status_failed (malformed)')
    if (availability.state === 'unavailable') return FLAG_UNREADABLE
    if (!availability.enabled) return 'paused'
    const state = await getLinearIntegrationState()
    return !state.configured ? null : state.connected ? 'connected' : 'notConnected'
  }
  const state = await getTelegramIntegrationStatus()
  return !state.configured ? null : state.connected ? 'connected' : 'notConnected'
}

/** A partial failure keeps that app's last successful state, with a visible error and its code under 详情.
 * An unreadable Linear flag keeps the last state too (paused when there is none), without an error. */
export async function fetchOwnAppStates(previous: Partial<Record<OwnAppId, OwnAppState>> = {}): Promise<OwnAppStates> {
  const results = await Promise.allSettled(OWN_APPS.map(fetchOwnAppState))
  const states = { ...previous }
  const failed: OwnAppId[] = []
  const codes: Partial<Record<OwnAppId, string>> = {}
  results.forEach((result, index) => {
    const id = OWN_APPS[index]
    if (result.status === 'rejected') {
      failed.push(id)
      const reason: unknown = result.reason
      codes[id] = reason instanceof OwnAppReadError ? reason.code : `${id}_status_failed (${reason instanceof Error ? reason.name : 'unknown'})`
    }
    else if (result.value === FLAG_UNREADABLE) states[id] = previous[id] ?? 'paused'
    else states[id] = result.value
  })
  return { states, failed, codes }
}

/** Where a page sits: the app (`&app=`) or a store section (`&category=`), from the URL. */
function readLocation() {
  const params = new URL(window.location.href).searchParams
  const app = params.get('app'), category = params.get('category')
  return { app: isToolkitSlug(app) ? app : null, category: category && category.length <= 80 ? category : null }
}

export type StoreEntry = { id: string; name: string; description: string; iconUrl: string | null; connect?: ConnectKind; credentialAlternative?: { id: string; name: string } | null }
export type StoreSectionData = { id: string; name: string; items: StoreEntry[]; preview: number }

export type PluginsTab = 'apps' | 'skills'
export type PluginsHref = (next?: { app?: string | null; category?: string | null }) => string
export type PluginsGo = (next: { app?: string | null; category?: string | null }) => void

export type PluginsViewMode = 'mcp' | 'integrations'

export interface PluginsViewProps {
  section?: 'plugins' | 'connections' | 'mcp'
  /** Splits Settings into Frame 11 `MCP 与插件` (`mode="mcp"`) vs Frame 12 `集成` (`mode="integrations"`). */
  mode?: PluginsViewMode
  rootLabel?: string
  linearNotice?: 'connected' | 'error' | null
  workspaceId?: string
  workspaceName?: string
}

/**
 * What 插件 and 设置 › 连接 read and where they are: the connected apps, the own apps' states (read on the list
 * only), the app (`&app=`) or store section (`&category=`) from the URL, and the store's tab and search, kept here so
 * back from an app's page finds the store as it was left. Shared with UI layers (the `plugins` slot).
 */
export function usePluginsView(section: 'plugins' | 'connections', linearNotice: 'connected' | 'error' | null = null) {
  const apps = useConnectedApps()
  const [app, setApp] = useState<string | null>(linearNotice ? 'linear' : null)
  const [category, setCategory] = useState<string | null>(null)
  const { cache } = useSWRConfig()
  const ownRead = useSWR<OwnAppStates>(app ? null : OWN_APP_STATES_KEY, () => fetchOwnAppStates((cache.get(OWN_APP_STATES_KEY)?.data as OwnAppStates | undefined)?.states))
  useEffect(() => {
    const read = () => { const next = readLocation(); if (next.app || !linearNotice) setApp(next.app); setCategory(next.category) }
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [linearNotice])
  const href: PluginsHref = (next = {}) => `?section=${section}${next.app ? `&app=${next.app}` : ''}${next.category ? `&category=${encodeURIComponent(next.category)}` : ''}`
  const go: PluginsGo = next => {
    const url = new URL(window.location.href)
    url.searchParams.set('section', section)
    for (const key of ['app', 'category'] as const) {
      const value = next[key]
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    goToHref(`${url.pathname}${url.search}${url.hash}`)
    setApp(next.app ?? null)
    setCategory(next.category ?? null)
  }
  const openApp = (next: string | null) => go({ app: next, category: next ? null : category })
  const [tab, setTab] = useViewState<PluginsTab>(`${section}:tab`, 'apps')
  const [query, setQuery] = useViewState(`${section}:query`, '')
  return { apps, ownRead, app, category, href, go, openApp, tab, setTab, query, setQuery }
}

export function PluginsView({ section = 'connections', mode, rootLabel, linearNotice = null, workspaceId, workspaceName }: PluginsViewProps) {
  if (section === 'plugins' && !mode) return <PluginsPage />
  if (mode === 'mcp' || section === 'mcp') {
    return <McpPluginsSettingsView rootLabel={rootLabel} workspaceId={workspaceId} workspaceName={workspaceName} />
  }
  if (mode === 'integrations') {
    return <IntegrationsSettingsView rootLabel={rootLabel} linearNotice={linearNotice} workspaceId={workspaceId} />
  }
  return <ConnectionsView rootLabel={rootLabel ?? ''} linearNotice={linearNotice} workspaceId={workspaceId} workspaceName={workspaceName} />
}

function ConnectionsView({ rootLabel, linearNotice = null, workspaceId, workspaceName }: {
  rootLabel: string; linearNotice?: 'connected' | 'error' | null; workspaceId?: string; workspaceName?: string
}) {
  const { apps, ownRead, app, category, href, go, openApp } = usePluginsView('connections', linearNotice)
  if (app) return <AppPage apps={apps} app={app} category={category} rootLabel={rootLabel} href={href} go={go} linearNotice={linearNotice} />
  return <ConnectionsList key={workspaceId} apps={apps} ownRead={ownRead} href={id => href({ app: id })} onOpen={openApp} workspaceId={workspaceId} workspaceName={workspaceName} />
}

/* ========================================================================== */
/* Frame 11 / 39 / 40 / 30 — MCP 与插件 (`mode="mcp"`)                         */
/* ========================================================================== */

type McpDetailSelection =
  | { kind: 'server'; id: string }
  | { kind: 'plugin'; id: string }
  | null

interface PersonalMcpListResponse {
  servers: McpServerView[]
  count: number
}

interface PersonalSkillsResponse {
  skills: InstalledSkill[]
  count: number
}

async function fetchPersonalMcpServers(): Promise<PersonalMcpListResponse> {
  const response = await fetch(withBasePath('/api/integrations/mcp'), { cache: 'no-store' })
  if (!response.ok) throw new ReadResponseError(response.status)
  return await response.json() as PersonalMcpListResponse
}

async function fetchInstalledSkills(): Promise<PersonalSkillsResponse> {
  const response = await fetch(withBasePath('/api/skills'), { cache: 'no-store' })
  if (!response.ok) throw new ReadResponseError(response.status)
  return await response.json() as PersonalSkillsResponse
}

function toWorkspaceServerView(server: McpServerView): McpWorkspaceServerView {
  return {
    ...server,
    ownerId: 'self',
    ownerName: null,
    mine: true,
    shared: false,
  }
}

function McpPluginsSettingsView({ rootLabel, workspaceId, workspaceName }: {
  rootLabel?: string
  workspaceId?: string
  workspaceName?: string
}) {
  const t = useTranslations('Settings.mcpIntegrations')
  const tMcp = useTranslations('Settings.mcpConnections')
  const common = useTranslations('Common')
  const apps = useConnectedApps()
  const info = useAppInfo()
  const catalog = useStoreCatalog()

  const workspaceMcpRead = useMcpConnections(workspaceId)
  const personalMcpRead = useSWR<PersonalMcpListResponse>(
    workspaceId ? null : 'settings:personal-mcp-servers',
    fetchPersonalMcpServers,
    noRefocusRead,
  )
  const skillsRead = useSWR<PersonalSkillsResponse>('settings:personal-skills', fetchInstalledSkills, noRefocusRead)

  const [selected, setSelected] = useState<McpDetailSelection>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [mcpCreating, setMcpCreating] = useState(false)
  const [mcpCreateFailed, setMcpCreateFailed] = useState(false)
  const [skillBusyId, setSkillBusyId] = useState<string | null>(null)
  const [removingSkill, setRemovingSkill] = useState<InstalledSkill | null>(null)

  const allServers: McpWorkspaceServerView[] = useMemo(() => {
    if (workspaceId) return workspaceMcpRead.data?.servers ?? []
    return (personalMcpRead.data?.servers ?? []).map(toWorkspaceServerView)
  }, [workspaceId, workspaceMcpRead.data?.servers, personalMcpRead.data?.servers])

  const canShare = Boolean(workspaceId && workspaceMcpRead.data?.canShare)

  const refreshMcp = async () => {
    if (workspaceId) {
      const next = await readMcpConnections(workspaceId)
      await workspaceMcpRead.mutate(next, { revalidate: false })
    } else {
      await personalMcpRead.mutate()
    }
  }

  async function handleCreateMcp(input: McpCreateInput) {
    if (mcpCreating) return
    setMcpCreating(true)
    setMcpCreateFailed(false)
    setMcpDialogOpen(false)
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      await refreshMcp()
    } catch {
      setMcpCreateFailed(true)
    } finally {
      setMcpCreating(false)
    }
  }

  async function toggleSkill(skill: InstalledSkill, enabled: boolean) {
    if (skillBusyId) return
    setSkillBusyId(skill.id)
    try {
      const response = await fetch(withBasePath('/api/skills'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skill.id, enabled }),
      })
      if (response.ok) await skillsRead.mutate()
    } finally {
      setSkillBusyId(null)
    }
  }

  async function confirmDeleteSkill() {
    if (!removingSkill || skillBusyId) return
    setSkillBusyId(removingSkill.id)
    try {
      const response = await fetch(withBasePath('/api/skills'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: removingSkill.id }),
      })
      if (response.ok) {
        setRemovingSkill(null)
        await skillsRead.mutate()
      }
    } finally {
      setSkillBusyId(null)
    }
  }

  const backLabel = rootLabel || t('mcpTitle')

  if (selected?.kind === 'server') {
    const server = allServers.find(item => item.id === selected.id)
    if (server) {
      return (
        <McpServerDetailSubView
          server={server}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          canShare={canShare}
          backLabel={backLabel}
          onBack={() => setSelected(null)}
          onChanged={refreshMcp}
        />
      )
    }
  }

  if (selected?.kind === 'plugin') {
    return (
      <ComposioPluginDetailSubView
        apps={apps}
        pluginId={selected.id}
        backLabel={backLabel}
        onBack={() => setSelected(null)}
      />
    )
  }

  const needle = searchQuery.trim().toLowerCase()
  const matchesText = (values: (string | null | undefined)[]) =>
    !needle || values.some(value => value && value.toLowerCase().includes(needle))

  const sharedServers = allServers.filter(server => server.shared && matchesText([server.name, server.transport, server.ownerName]))
  const personalServers = allServers.filter(server => !server.shared && matchesText([server.name, server.transport]))

  const composioToolkits = apps.connectedToolkits().filter(id => id !== 'slack')
  const filteredToolkits = composioToolkits.filter(id => {
    const meta = info(id)
    return matchesText([id, meta.name, meta.description])
  })

  const installedSkills = (skillsRead.data?.skills ?? []).filter(skill => matchesText([skill.name, skill.source, skill.slug]))
  const totalSharedCount = allServers.filter(s => s.shared).length + composioToolkits.length
  const mcpLoadError = Boolean(workspaceId ? workspaceMcpRead.error : personalMcpRead.error)
  const mcpLoading = Boolean(workspaceId ? (workspaceMcpRead.isLoading && !workspaceMcpRead.data) : (personalMcpRead.isLoading && !personalMcpRead.data))

  const GitHubMark = APP_ICONS.github
  const SlackMark = APP_ICONS.slack
  const LinearMark = APP_ICONS.linear

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-4 text-xs text-muted-foreground">{t('mcpSubtitle')}</p>

      <SettingsSection id="mcp-quick-entry">
        <SettingRow
          icon={<IconTile variant="outline" size="sm" aria-hidden="true"><SquareTerminal /></IconTile>}
          title={t('setupWithMikka')}
        >
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={workspaceLink({})} />}>
            {t('newThreadAction')}
          </Button>
        </SettingRow>
        <Link
          href={workspaceLink({ section: 'plugins' })}
          className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-3">
            <IconTile variant="outline" size="sm" aria-hidden="true"><Blocks /></IconTile>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{t('browseMarketplaceTitle')}</span>
              <span className="text-xs text-muted-foreground">{t('browseMarketplaceDescription')}</span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span aria-hidden="true" className="flex items-center gap-1.5">
              <GitHubMark className="size-3.5" />
              <SlackMark className="size-3.5" />
              <LinearMark className="size-3.5" />
            </span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
          </span>
        </Link>
      </SettingsSection>

      {mcpLoadError ? (
        <SettingsSaveError message={tMcp('loadFailed')} retryLabel={common('retry')} onRetry={() => { void refreshMcp() }} />
      ) : null}
      {mcpCreateFailed ? (
        <SettingsSaveError message={t('mcpCreateFailed')} retryLabel={common('retry')} onRetry={() => setMcpDialogOpen(true)} />
      ) : null}

      <SettingsSection
        id="mcp-workspace-shared-heading"
        title={t('workspaceSharedHeading')}
        description={t('workspaceSharedDescription')}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          {searchOpen ? (
            <SearchInput
              aria-label={t('searchPlaceholder')}
              placeholder={t('searchPlaceholder')}
              className="h-(--control-sm) min-w-0 flex-1"
              autoFocus
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
            />
          ) : (
            <span className="text-xs font-medium text-foreground">
              {t('sharedItemsCount', { count: totalSharedCount })}
            </span>
          )}

          <div className="flex shrink-0 items-center gap-1">
            {searchOpen ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('closeSearchAria')}
                onClick={() => { setSearchQuery(''); setSearchOpen(false) }}
              >
                <X aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('openSearchAria')}
                onClick={() => setSearchOpen(true)}
              >
                <Search aria-hidden="true" />
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('addMenuAria')} />}
              >
                <Plus aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => goToHref(workspaceLink({ section: 'plugins' }))}>
                    <Blocks data-icon="inline-start" aria-hidden="true" />
                    {t('addFromMarketplace')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSkillDialogOpen(true)}>
                    <FolderGit2 data-icon="inline-start" aria-hidden="true" />
                    {t('addFromGitHub')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMcpDialogOpen(true)}>
                    <Server data-icon="inline-start" aria-hidden="true" />
                    {t('addMcpServerOption')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {mcpLoading && apps.loading ? (
          <SettingsLoading bare label={tMcp('loading')} rows={2} />
        ) : sharedServers.length === 0 && filteredToolkits.length === 0 ? (
          <SettingRow title={needle ? t('noSearchMatches') : t('emptyWorkspaceShared')} />
        ) : (
          <>
            {filteredToolkits.map(toolkitId => {
              const meta = info(toolkitId)
              const accounts = apps.accountsFor(toolkitId)
              const { expired, on } = appState(accounts)
              const storeApp = catalog.data?.apps.find(entry => entry.id === toolkitId)
              return (
                <Button
                  key={`plugin:${toolkitId}`}
                  type="button"
                  variant="ghost"
                  onClick={() => setSelected({ kind: 'plugin', id: toolkitId })}
                  className="flex h-auto w-full justify-start items-center gap-3 rounded-none px-4 py-3 text-left font-normal hover:bg-muted/40"
                >
                  <AppTile app={toolkitId} iconUrl={meta.iconUrl} dim={!on || expired} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">{meta.name}</span>
                      {storeApp && 'version' in storeApp && typeof storeApp.version === 'string' ? (
                        <Badge size="sm" variant="secondary">{storeApp.version}</Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{t('pluginRowMeta')}</span>
                  </span>
                  {expired ? (
                    <Badge tone="warning">
                      <TriangleAlert data-icon="inline-start" aria-hidden="true" />
                      {t('badgeNeedsConnect')}
                    </Badge>
                  ) : on ? (
                    <Badge tone="success">
                      <CircleCheck data-icon="inline-start" aria-hidden="true" />
                      {t('badgeConnected')}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">{t('badgeDisabled')}</Badge>
                  )}
                  <ChevronRight data-icon="inline-end" aria-hidden="true" className="shrink-0 text-muted-foreground" />
                </Button>
              )
            })}

            {sharedServers.map(server => (
              <Button
                key={`server:${server.id}`}
                type="button"
                variant="ghost"
                onClick={() => setSelected({ kind: 'server', id: server.id })}
                className="flex h-auto w-full justify-start items-center gap-3 rounded-none px-4 py-3 text-left font-normal hover:bg-muted/40"
              >
                <IconTile variant="outline" size="sm" aria-hidden="true"><Server data-icon="inline-start" /></IconTile>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[
                      server.transport.toUpperCase(),
                      server.mine ? tMcp('sharedReadOnly') : tMcp('sharedBy', { name: server.ownerName ?? tMcp('member') }),
                    ].join(' · ')}
                  </span>
                </span>
                {server.enabled ? (
                  <Badge tone="success">
                    <CircleCheck data-icon="inline-start" aria-hidden="true" />
                    {t('badgeConnected')}
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t('badgeDisabled')}</Badge>
                )}
                <ChevronRight data-icon="inline-end" aria-hidden="true" className="shrink-0 text-muted-foreground" />
              </Button>
            ))}
          </>
        )}
      </SettingsSection>

      <SettingsSection id="mcp-personal-heading" title={t('personalHeading')}>
        {personalServers.length === 0 && installedSkills.length === 0 ? (
          <SettingRow title={needle ? t('noSearchMatches') : t('emptyPersonalItems')} />
        ) : (
          <>
            {personalServers.map(server => (
              <Button
                key={`personal-server:${server.id}`}
                type="button"
                variant="ghost"
                onClick={() => setSelected({ kind: 'server', id: server.id })}
                className="flex h-auto w-full justify-start items-center gap-3 rounded-none px-4 py-3 text-left font-normal hover:bg-muted/40"
              >
                <IconTile variant="outline" size="sm" aria-hidden="true"><Server data-icon="inline-start" /></IconTile>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {`${server.transport.toUpperCase()} · ${tMcp('onlyYou')}`}
                  </span>
                </span>
                <Badge tone={server.enabled ? 'success' : 'neutral'}>
                  {server.enabled ? t('badgeEnabled') : t('badgeDisabled')}
                </Badge>
                <ChevronRight data-icon="inline-end" aria-hidden="true" className="shrink-0 text-muted-foreground" />
              </Button>
            ))}

            {installedSkills.map(skill => (
              <SettingRow
                key={`skill:${skill.id}`}
                icon={<IconTile variant="outline" size="sm" aria-hidden="true"><Puzzle /></IconTile>}
                title={skill.name}
                description={`${skill.source} · ${skill.slug}`}
              >
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label={t('toggleSkillAria', { name: skill.name })}
                    checked={skill.enabled}
                    disabled={skillBusyId === skill.id}
                    onCheckedChange={checked => { void toggleSkill(skill, checked) }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={skillBusyId === skill.id}
                    aria-label={t('removeSkillAria', { name: skill.name })}
                    onClick={() => setRemovingSkill(skill)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </SettingRow>
            ))}
          </>
        )}
      </SettingsSection>

      <Dialog open={mcpDialogOpen} onOpenChange={open => { if (!mcpCreating) setMcpDialogOpen(open) }}>
        <DialogContent closeLabel={common('close')} className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{tMcp('add')}</DialogTitle></DialogHeader>
          {mcpDialogOpen ? (
            <McpServerCreateForm
              pending={mcpCreating}
              onCancel={() => setMcpDialogOpen(false)}
              onCreate={input => { void handleCreateMcp(input) }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <InstallGitHubSkillDialog
        open={skillDialogOpen}
        onClose={() => setSkillDialogOpen(false)}
        onInstalled={async () => {
          setSkillDialogOpen(false)
          await skillsRead.mutate()
        }}
      />

      <AlertDialog open={removingSkill !== null} onOpenChange={open => { if (!open && !skillBusyId) setRemovingSkill(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeSkillTitle', { name: removingSkill?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('removeSkillDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(skillBusyId)}>{common('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={Boolean(skillBusyId)} onClick={event => { event.preventDefault(); void confirmDeleteSkill() }}>
              {t('removeAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function McpServerDetailSubView({
  server,
  workspaceId,
  workspaceName,
  canShare,
  backLabel,
  onBack,
  onChanged,
}: {
  server: McpWorkspaceServerView
  workspaceId?: string
  workspaceName?: string
  canShare: boolean
  backLabel: string
  onBack: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('Settings.mcpIntegrations')
  const tMcp = useTranslations('Settings.mcpConnections')
  const common = useTranslations('Common')

  const [busy, setBusy] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [sharingConfirm, setSharingConfirm] = useState(false)
  const [removingConfirm, setRemovingConfirm] = useState(false)
  const [editingVars, setEditingVars] = useState(false)
  const [varRows, setVarRows] = useState<{ name: string; value: string }[]>([])
  const [varError, setVarError] = useState(false)

  const [toolState, setToolState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [tools, setTools] = useState<{ name: string }[]>([])
  const [toolFilter, setToolFilter] = useState('')
  const [showAllTools, setShowAllTools] = useState(false)

  const canInspectTools = server.mine && server.enabled && server.transport !== 'stdio'

  async function inspectTools() {
    if (!canInspectTools) return
    setToolState('loading')
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      const body = await response.json() as { serverId: string; tools: { name: string }[] }
      if (body.serverId !== server.id || !Array.isArray(body.tools)) throw new Error('tool_mismatch')
      setTools(body.tools)
      setToolState('ready')
    } catch {
      setToolState('error')
    }
  }

  useEffect(() => {
    setTools([])
    setToolFilter('')
    setShowAllTools(false)
    if (canInspectTools) void inspectTools()
    else setToolState('idle')
    // Inspect once on detail open for eligible remote servers; manual button re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, server.revision, canInspectTools])

  async function toggleEnabled(enabled: boolean) {
    if (!server.mine || busy) return
    setBusy(true)
    setSaveFailed(false)
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id, enabled }),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      await onChanged()
    } catch {
      setSaveFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function updateShare(shared: boolean) {
    if (!server.mine || !workspaceId || !canShare || busy) return
    setBusy(true)
    setSaveFailed(false)
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp/shares'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, workspaceId, shared }),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      setSharingConfirm(false)
      await onChanged()
    } catch {
      setSaveFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function saveVariables(event: FormEvent) {
    event.preventDefault()
    if (!server.mine || busy) return
    const values: Record<string, string> = Object.create(null)
    const seen = new Set<string>()
    for (const row of varRows) {
      if (!row.name && !row.value) continue
      const keyName = row.name.trim()
      const normalized = server.transport === 'stdio' ? keyName : keyName.toLowerCase()
      const valid = server.transport === 'stdio'
        ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)
        : (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(keyName) && !/^(?:host|cookie|set-cookie|connection|content-length|transfer-encoding|proxy-.*|x-forwarded-.*)$/i.test(keyName))
      if (!keyName || !row.value || seen.has(normalized) || !valid) {
        setVarError(true)
        return
      }
      seen.add(normalized)
      values[keyName] = row.value
    }
    setBusy(true)
    setVarError(false)
    try {
      const payload = server.transport === 'stdio'
        ? { id: server.id, env: values }
        : { id: server.id, headers: seen.size > 0 ? values : null }
      const response = await fetch(withBasePath('/api/integrations/mcp'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      setVarRows([])
      setEditingVars(false)
      await onChanged()
    } catch {
      setVarError(true)
    } finally {
      setBusy(false)
    }
  }

  async function confirmRemoveServer() {
    if (!server.mine || busy) return
    setBusy(true)
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: server.id }),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      setRemovingConfirm(false)
      await onChanged()
      onBack()
    } catch {
      setSaveFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const toolPrefix = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp'
  const filteredTools = toolFilter.trim()
    ? tools.filter(tool => tool.name.toLowerCase().includes(toolFilter.trim().toLowerCase()))
    : tools
  const visibleTools = showAllTools || toolFilter.trim() ? filteredTools : filteredTools.slice(0, TOOL_PREVIEW_COUNT)
  const hiddenToolCount = Math.max(0, filteredTools.length - visibleTools.length)

  return (
    <div data-settings-subview="" className="flex flex-col gap-6">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden="true" />
        {backLabel}
      </Button>

      <header className="flex items-center gap-3 pl-1">
        <IconTile variant="outline" size="default" aria-hidden="true"><Server /></IconTile>
        <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground">{server.name}</h2>
      </header>

      {saveFailed ? (
        <SettingsSaveError message={tMcp('loadFailed')} retryLabel={common('retry')} onRetry={() => { void onChanged() }} />
      ) : null}

      <SettingsSection id="mcp-detail-status">
        <SettingRow title={t('enableServerLabel')} description={t('enableServerDescription')}>
          <Switch
            aria-label={t('enableServerLabel')}
            checked={server.enabled}
            disabled={!server.mine || busy}
            onCheckedChange={checked => { void toggleEnabled(checked) }}
          />
        </SettingRow>
        <SettingRow
          title={t('connectionStatusLabel')}
          description={toolState === 'ready'
            ? t('toolsCountMeta', { count: tools.length })
            : server.transport.toUpperCase()}
        >
          <div className="flex flex-wrap items-center gap-2">
            {toolState === 'error' ? (
              <Badge tone="warning">
                <TriangleAlert data-icon="inline-start" aria-hidden="true" />
                {t('badgeCheckFailed')}
              </Badge>
            ) : !server.enabled ? (
              <Badge tone="neutral">{t('badgeDisabled')}</Badge>
            ) : toolState === 'ready' ? (
              <Badge tone="success">
                <CircleCheck data-icon="inline-start" aria-hidden="true" />
                {t('badgeConnected')}
              </Badge>
            ) : (
              <Badge tone="neutral">{t('badgeUnchecked')}</Badge>
            )}
            {canInspectTools ? (
              <Button type="button" variant="outline" size="sm" disabled={toolState === 'loading'} onClick={() => { void inspectTools() }}>
                {t('testConnectionButton')}
              </Button>
            ) : null}
          </div>
        </SettingRow>
      </SettingsSection>

      {toolState === 'error' ? (
        <SettingsSaveError message={tMcp('toolsFailed')} retryLabel={tMcp('checkAgain')} onRetry={() => { void inspectTools() }} />
      ) : null}

      <SettingsSection id="mcp-detail-metadata">
        <SettingRow title={t('ownerFieldLabel')} description={server.shared ? t('ownerWorkspaceDescription') : t('ownerPersonalDescription')}>
          {server.mine && canShare ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{server.shared ? t('scopeWorkspace') : tMcp('onlyYou')}</span>
              <Switch
                aria-label={tMcp('shareLabel', { name: server.name })}
                checked={server.shared}
                disabled={busy}
                onCheckedChange={checked => {
                  if (checked) setSharingConfirm(true)
                  else void updateShare(false)
                }}
              />
            </div>
          ) : (
            <span className="text-muted-foreground">
              {server.shared ? t('scopeWorkspace') : server.mine ? tMcp('onlyYou') : (server.ownerName ?? tMcp('member'))}
            </span>
          )}
        </SettingRow>
        <SettingRow title={tMcp('transport')} description={server.url ?? undefined}>
          <span className="text-muted-foreground">{server.transport.toUpperCase()}</span>
        </SettingRow>
        <SettingRow title={t('toolPrefixLabel')} description={t('toolPrefixDescription')}>
          <span className="font-mono text-xs text-muted-foreground">{toolPrefix}</span>
        </SettingRow>
      </SettingsSection>

      {server.mine ? (
        <SettingsSection
          id="mcp-detail-variables"
          title={tMcp(server.transport === 'stdio' ? 'variables' : 'headers')}
          description={t('variablesWriteOnlyDescription')}
        >
          <SettingRow
            title={server.authKind !== 'none' ? t('credentialsConfigured') : t(server.transport === 'stdio' ? 'noVariables' : 'noHeaders')}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={tMcp(server.transport === 'stdio' ? 'addVariable' : 'addHeader')}
              onClick={() => { setVarRows([{ name: '', value: '' }]); setVarError(false); setEditingVars(true) }}
            >
              <Plus aria-hidden="true" />
            </Button>
          </SettingRow>
        </SettingsSection>
      ) : null}

      {canInspectTools ? (
        <SettingsSection
          id="mcp-detail-tools-heading"
          title={t('toolsSectionHeading', { count: tools.length })}
          action={
            <div className="flex items-center gap-2">
              {tools.length > 0 ? (
                <SearchInput
                  aria-label={t('filterToolsPlaceholder')}
                  placeholder={t('filterToolsPlaceholder')}
                  className="h-(--control-sm) w-44"
                  value={toolFilter}
                  onChange={event => setToolFilter(event.target.value)}
                />
              ) : null}
              <Button type="button" variant="ghost" size="sm" disabled={toolState === 'loading'} onClick={() => { void inspectTools() }}>
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {t('refreshButton')}
              </Button>
            </div>
          }
        >
          {toolState === 'loading' ? (
            <SettingsLoading bare label={tMcp('loadingTools')} rows={3} />
          ) : visibleTools.length === 0 ? (
            <SettingRow title={tMcp('emptyTools')} />
          ) : (
            <>
              {visibleTools.map(tool => (
                <SettingRow key={tool.name} title={tool.name} />
              ))}
              {hiddenToolCount > 0 ? (
                <div className="px-4 py-2.5">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllTools(true)}>
                    {t('showRemainingTools', { count: hiddenToolCount })}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </SettingsSection>
      ) : null}

      {server.mine ? (
        <SettingsSection id="mcp-detail-danger" title={t('connectionDangerHeading')}>
          <SettingRow title={t('removeServerLabel')}>
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => setRemovingConfirm(true)}>
              {t('removeAction')}
            </Button>
          </SettingRow>
        </SettingsSection>
      ) : null}

      <Dialog open={editingVars} onOpenChange={open => { if (!busy) setEditingVars(open) }}>
        <DialogContent closeLabel={common('close')} className="sm:max-w-md" aria-describedby={undefined}>
          <form className="flex flex-col gap-4" autoComplete="off" onSubmit={event => { void saveVariables(event) }}>
            <DialogHeader>
              <DialogTitle>{tMcp(server.transport === 'stdio' ? 'variables' : 'headers')}</DialogTitle>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>{tMcp(server.transport === 'stdio' ? 'variables' : 'headers')}</FieldLabel>
                {varRows.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      className="h-(--control-sm)"
                      aria-label={tMcp('variableName', { index: index + 1 })}
                      maxLength={128}
                      required
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={busy}
                      placeholder="KEY"
                      value={row.name}
                      onChange={event => {
                        const value = event.target.value
                        setVarRows(current => current.map((item, idx) => idx === index ? { ...item, name: value } : item))
                        setVarError(false)
                      }}
                    />
                    <Input
                      className="h-(--control-sm)"
                      aria-label={tMcp('variableValue', { index: index + 1 })}
                      type="password"
                      autoComplete="new-password"
                      maxLength={4096}
                      required
                      disabled={busy}
                      value={row.value}
                      onChange={event => {
                        const value = event.target.value
                        setVarRows(current => current.map((item, idx) => idx === index ? { ...item, value } : item))
                        setVarError(false)
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={tMcp('removeVariable', { index: index + 1 })}
                      onClick={() => setVarRows(current => current.filter((_, idx) => idx !== index))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  disabled={busy || varRows.length >= 32}
                  onClick={() => setVarRows(current => [...current, { name: '', value: '' }])}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {tMcp(server.transport === 'stdio' ? 'addVariable' : 'addHeader')}
                </Button>
              </Field>
              {varError ? <FieldError role="alert">{tMcp('invalidConfiguration')}</FieldError> : null}
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setEditingVars(false)}>
                {common('cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {common('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={sharingConfirm} onOpenChange={open => { if (!open && !busy) setSharingConfirm(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tMcp('confirmTitle', { name: server.name, workspace: workspaceName ?? tMcp('currentWorkspace') })}</AlertDialogTitle>
            <AlertDialogDescription>{tMcp('confirmAuthority')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{common('cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void updateShare(true) }}>
              {tMcp('confirmShare')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removingConfirm} onOpenChange={open => { if (!open && !busy) setRemovingConfirm(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeServerConfirmTitle', { name: server.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('removeServerConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{common('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={event => { event.preventDefault(); void confirmRemoveServer() }}>
              {t('removeAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ComposioPluginDetailSubView({
  apps,
  pluginId,
  backLabel,
  onBack,
}: {
  apps: ConnectedApps
  pluginId: string
  backLabel: string
  onBack: () => void
}) {
  return (
    <div data-settings-subview="" className="flex flex-col gap-6 [&_nav[aria-label=breadcrumb]]:hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden="true" />
        {backLabel}
      </Button>
      <ConnectedAppDetail
        apps={apps}
        app={pluginId}
        rootLabel={backLabel}
        rootHref={withBasePath('/settings?section=connections')}
        onBack={onBack}
      />
    </div>
  )
}

function McpServerCreateForm({
  pending,
  onCancel,
  onCreate,
}: {
  pending: boolean
  onCancel: () => void
  onCreate: (input: McpCreateInput) => void
}) {
  const t = useTranslations('Settings.mcpConnections')
  const common = useTranslations('Common')
  const [draft, setDraft] = useState<McpServerDraft>({ name: '', transport: 'http', url: '', command: '', arguments: '', cwd: '', values: [] })
  const [error, setError] = useState(false)
  const stdio = draft.transport === 'stdio'

  const change = <K extends keyof McpServerDraft>(key: K, value: McpServerDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setError(false)
  }
  const changeValue = (index: number, key: 'name' | 'value', value: string) =>
    change('values', draft.values.map((row, idx) => idx === index ? { ...row, [key]: value } : row))

  function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    try {
      const input = mcpServerInput(draft)
      change('values', [])
      onCreate(input)
    } catch {
      setError(true)
    }
  }

  return (
    <form className="flex min-h-0 flex-col gap-4" autoComplete="off" onSubmit={submit}>
      <FieldGroup className="min-h-0 overflow-y-auto px-0.5 pb-1">
        <Field>
          <FieldLabel htmlFor="mcp-create-name">{t('name')}</FieldLabel>
          <Input id="mcp-create-name" maxLength={80} required disabled={pending} value={draft.name} onChange={event => change('name', event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="mcp-create-transport">{t('transport')}</FieldLabel>
          <NativeSelect
            id="mcp-create-transport"
            value={draft.transport}
            disabled={pending}
            onChange={event => {
              change('transport', event.target.value as McpServerDraft['transport'])
              change('values', [])
            }}
          >
            <NativeSelectOption value="http">Streamable HTTP</NativeSelectOption>
            <NativeSelectOption value="sse">SSE</NativeSelectOption>
            <NativeSelectOption value="stdio">STDIO</NativeSelectOption>
          </NativeSelect>
        </Field>
        {stdio ? (
          <>
            <Field>
              <FieldLabel htmlFor="mcp-create-command">{t('command')}</FieldLabel>
              <Input id="mcp-create-command" autoCapitalize="off" spellCheck={false} maxLength={4096} required disabled={pending} value={draft.command} onChange={event => change('command', event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-create-args">{t('arguments')}</FieldLabel>
              <Textarea id="mcp-create-args" autoCapitalize="off" spellCheck={false} maxLength={32768} disabled={pending} value={draft.arguments} onChange={event => change('arguments', event.target.value)} />
              <FieldDescription>{t('oneArgumentPerLine')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-create-cwd">{t('cwd')}</FieldLabel>
              <Input id="mcp-create-cwd" autoCapitalize="off" spellCheck={false} maxLength={4096} disabled={pending} value={draft.cwd} onChange={event => change('cwd', event.target.value)} />
            </Field>
          </>
        ) : (
          <Field>
            <FieldLabel htmlFor="mcp-create-url">{t('url')}</FieldLabel>
            <Input id="mcp-create-url" type="url" required autoCapitalize="off" spellCheck={false} maxLength={4096} disabled={pending} value={draft.url} onChange={event => change('url', event.target.value)} />
          </Field>
        )}
        <Field>
          <FieldLabel>{t(stdio ? 'variables' : 'headers')}</FieldLabel>
          {draft.values.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input className="h-(--control-sm)" aria-label={t('variableName', { index: index + 1 })} maxLength={128} required autoCapitalize="off" spellCheck={false} disabled={pending} value={row.name} onChange={event => changeValue(index, 'name', event.target.value)} />
              <Input className="h-(--control-sm)" aria-label={t('variableValue', { index: index + 1 })} type="password" autoComplete="new-password" maxLength={4096} required disabled={pending} value={row.value} onChange={event => changeValue(index, 'value', event.target.value)} />
              <Button type="button" size="icon-sm" variant="ghost" disabled={pending} aria-label={t('removeVariable', { index: index + 1 })} onClick={() => change('values', draft.values.filter((_, idx) => idx !== index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" className="self-start" disabled={pending || draft.values.length >= 32} onClick={() => change('values', [...draft.values, { name: '', value: '' }])}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            {t(stdio ? 'addVariable' : 'addHeader')}
          </Button>
          <FieldDescription>{t('taskReadable')}</FieldDescription>
        </Field>
        {error ? <FieldError role="alert">{t('invalidConfiguration')}</FieldError> : null}
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onCancel}>{common('cancel')}</Button>
        <Button type="submit" size="sm" disabled={pending}>{t('add')}</Button>
      </DialogFooter>
    </form>
  )
}

function InstallGitHubSkillDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean
  onClose: () => void
  onInstalled: () => Promise<void>
}) {
  const t = useTranslations('Settings.mcpIntegrations')
  const common = useTranslations('Common')
  const [source, setSource] = useState('')
  const [slug, setSlug] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setSource('')
      setSlug('')
      setError('')
    }
  }, [open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const trimmedSource = source.trim()
    const trimmedSlug = slug.trim()
    if (!SKILL_SOURCE_REGEX.test(trimmedSource) || !SKILL_SLUG_REGEX.test(trimmedSlug)) {
      setError(t('skillValidationFailed'))
      return
    }
    setSaving(true)
    setError('')
    try {
      const response = await fetch(withBasePath('/api/skills'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: trimmedSource, slug: trimmedSlug }),
      })
      if (!response.ok) {
        setError(t('skillInstallFailed'))
        return
      }
      await onInstalled()
    } catch {
      setError(t('skillInstallFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !saving) onClose() }}>
      <DialogContent closeLabel={common('close')} className="sm:max-w-md" aria-describedby={undefined}>
        <form className="flex flex-col gap-4" onSubmit={event => { void submit(event) }}>
          <DialogHeader><DialogTitle>{t('installSkillTitle')}</DialogTitle></DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="github-skill-source">{t('skillSourceLabel')}</FieldLabel>
              <Input
                id="github-skill-source"
                required
                maxLength={201}
                autoCapitalize="off"
                spellCheck={false}
                disabled={saving}
                placeholder="owner/repo"
                value={source}
                onChange={event => { setSource(event.target.value); setError('') }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="github-skill-slug">{t('skillSlugLabel')}</FieldLabel>
              <Input
                id="github-skill-slug"
                required
                maxLength={100}
                autoCapitalize="off"
                spellCheck={false}
                disabled={saving}
                placeholder="skill-name"
                value={slug}
                onChange={event => { setSlug(event.target.value); setError('') }}
              />
            </Field>
            {error ? <FieldError role="alert">{error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={onClose}>
              {common('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={saving || !source.trim() || !slug.trim()}>
              {saving ? common('saving') : t('installSkillAction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ========================================================================== */
/* Frame 12 — 集成 (`mode="integrations"`)                                    */
/* ========================================================================== */

type IntegrationTarget = 'github' | 'slack' | 'linear' | 'telegram'

const INTEGRATION_TARGETS: readonly IntegrationTarget[] = ['github', 'slack', 'linear', 'telegram']

function isIntegrationTarget(value: string | null): value is IntegrationTarget {
  return value !== null && (INTEGRATION_TARGETS as readonly string[]).includes(value)
}

interface SlackSummaryResponse {
  configured: boolean
  installation: { teamName: string; connected: boolean; enabled: boolean } | null
}

async function fetchSlackSummary([, workspaceId]: readonly [string, string]): Promise<SlackSummaryResponse | null> {
  const response = await fetch(withBasePath(`/api/integrations/slack?workspaceId=${encodeURIComponent(workspaceId)}`), { cache: 'no-store' })
  if (!response.ok) return null
  return await response.json() as SlackSummaryResponse
}

function IntegrationsSettingsView({
  rootLabel,
  linearNotice = null,
  workspaceId,
}: {
  rootLabel?: string
  linearNotice?: 'connected' | 'error' | null
  workspaceId?: string
}) {
  const t = useTranslations('Settings.mcpIntegrations')
  const { cache } = useSWRConfig()
  const apps = useConnectedApps()
  const [selected, setSelected] = useState<IntegrationTarget | null>(linearNotice ? 'linear' : null)

  useEffect(() => {
    const sync = () => {
      const appParam = new URL(window.location.href).searchParams.get('app')
      if (isIntegrationTarget(appParam)) setSelected(appParam)
      else if (!linearNotice) setSelected(null)
    }
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [linearNotice])

  const ownRead = useSWR<OwnAppStates>(
    selected ? null : OWN_APP_STATES_KEY,
    () => fetchOwnAppStates((cache.get(OWN_APP_STATES_KEY)?.data as OwnAppStates | undefined)?.states),
  )
  const slackSummary = useSWR<SlackSummaryResponse | null>(
    !selected && workspaceId ? ['settings:slack-summary', workspaceId] as const : null,
    fetchSlackSummary,
    noRefocusRead,
  )

  function openIntegration(target: IntegrationTarget | null) {
    setSelected(target)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (target) url.searchParams.set('app', target)
    else url.searchParams.delete('app')
    goToHref(`${url.pathname}${url.search}${url.hash}`)
  }

  const backLabel = rootLabel || t('integrationsTitle')

  if (selected) {
    return (
      <div data-settings-subview="" className="flex flex-col gap-6">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 self-start text-muted-foreground hover:text-foreground"
          onClick={() => openIntegration(null)}
        >
          <ChevronLeft data-icon="inline-start" aria-hidden="true" />
          {backLabel}
        </Button>

        {selected === 'github' ? <GitHubSettings /> : null}
        {selected === 'slack' ? <SlackIntegrationSubView workspaceId={workspaceId} apps={apps} /> : null}
        {selected === 'linear' ? <LinearSettings notice={linearNotice} /> : null}
        {selected === 'telegram' ? <TelegramSettings /> : null}
      </div>
    )
  }

  const states = ownRead.data?.states
  const slackComposioOn = appState(apps.accountsFor('slack')).on
  const slackConnected = Boolean(slackSummary.data?.installation?.connected || slackComposioOn)

  return (
    <div className="flex flex-col gap-6">
      <p className="-mt-4 text-xs text-muted-foreground">{t('integrationsSubtitle')}</p>

      <OwnAppsStatus read={ownRead} />

      <SettingsSection id="integrations-main-card">
        <IntegrationRow
          app="github"
          name="GitHub"
          description={t('githubRowDescription')}
          badge={renderOwnBadge(states?.github, t)}
          onClick={() => openIntegration('github')}
        />
        <IntegrationRow
          app="slack"
          name="Slack"
          description={t('slackRowDescription')}
          badge={slackConnected ? (
            <Badge tone="success">
              <CircleCheck data-icon="inline-start" aria-hidden="true" />
              {t('badgeConnected')}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('badgeNotConnected')}</Badge>
          )}
          onClick={() => openIntegration('slack')}
        />
        <IntegrationRow
          app="linear"
          name="Linear"
          description={t('linearRowDescription')}
          badge={renderOwnBadge(states?.linear, t)}
          onClick={() => openIntegration('linear')}
        />
      </SettingsSection>

      <SettingsSection id="integrations-mikka-card" title={t('mikkaIntegrationsHeading')}>
        <IntegrationRow
          app="telegram"
          name="Telegram"
          description={t('telegramRowDescription')}
          badge={renderOwnBadge(states?.telegram, t)}
          onClick={() => openIntegration('telegram')}
        />
      </SettingsSection>
    </div>
  )
}

function renderOwnBadge(state: OwnAppState | undefined, t: ReturnType<typeof useTranslations<'Settings.mcpIntegrations'>>): ReactNode {
  if (state === 'connected') {
    return (
      <Badge tone="success">
        <CircleCheck data-icon="inline-start" aria-hidden="true" />
        {t('badgeConnected')}
      </Badge>
    )
  }
  if (state === 'paused') return <Badge tone="neutral">{t('badgePaused')}</Badge>
  if (state === 'notConnected') return <Badge tone="neutral">{t('badgeNotConnected')}</Badge>
  return null
}

function IntegrationRow({
  app,
  name,
  description,
  badge,
  onClick,
}: {
  app: string
  name: string
  description: string
  badge?: ReactNode
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'flex h-auto w-full justify-start items-center gap-3 rounded-none px-4 py-3 text-left font-normal hover:bg-muted/40',
      )}
    >
      <AppTile app={app} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{description}</span>
      </span>
      {badge}
      <ChevronRight data-icon="inline-end" aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </Button>
  )
}

function SlackIntegrationSubView({ workspaceId, apps }: { workspaceId?: string; apps: ConnectedApps }) {
  const t = useTranslations('Settings.slackInstallation')
  const { data: session, isPending } = authClient.useSession()
  const viewerId = !isPending ? session?.user?.id : undefined

  if (!workspaceId || !viewerId) {
    return (
      <SettingsSection id="slack-integration-loading" title={t('title')}>
        <SettingRow title={t('loading')} />
      </SettingsSection>
    )
  }

  return <SlackWorkspaceSettings key={`${viewerId}:${workspaceId}`} viewerId={viewerId} workspaceId={workspaceId} apps={apps} />
}

function SlackWorkspaceSettings({ viewerId, workspaceId, apps }: { viewerId: string; workspaceId: string; apps: ConnectedApps }) {
  const t = useTranslations('Settings.slackInstallation')
  const { result, selecting, setSelecting, working, notice, act } = useSlackInstallation(viewerId, workspaceId)
  const [confirmOp, setConfirmOp] = useState<'unlink' | 'uninstall' | null>(null)
  const status = result.data
  const install = status?.installation
  const connected = install?.connected === true
  const stateLabel = !status
    ? t('loading')
    : !status.configured
      ? t('unconfigured')
      : install?.revoking
        ? t('revoking')
        : connected && install
          ? t('connected', { team: install.teamName })
          : t('unlinked')

  const slackAccounts = apps.accountsFor('slack')

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3 pl-1">
        <AppTile app="slack" size="xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">Slack</h2>
          <p className="text-xs text-muted-foreground">{t('note')}</p>
        </div>
      </header>

      {result.error ? (
        <SettingsSaveError message={t('readFailed')} retryLabel={t('retry')} onRetry={() => { void result.mutate() }} />
      ) : null}
      {notice ? <p role="status" className="text-xs text-muted-foreground">{t(notice)}</p> : null}

      <SettingsSection id="slack-bot-installation" title={t('title')}>
        <SettingRow title="Slack" description={stateLabel}>
          <div className="flex items-center gap-2">
            {status?.configured && !connected && !install?.revoking ? (
              <Button type="button" size="sm" disabled={working} onClick={() => { void act({ operation: 'connect' }) }}>
                {t(install ? 'link' : 'connect')}
              </Button>
            ) : null}
            {connected && !install?.revoking ? (
              <Button type="button" variant="secondary" size="sm" disabled={working} onClick={() => setConfirmOp('unlink')}>
                {t('unlink')}
              </Button>
            ) : null}
          </div>
        </SettingRow>

        {connected && install && !install.revoking ? (
          <>
            <SettingRow title={t('enabled')}>
              <Switch
                aria-label={t('enabled')}
                checked={install.enabled}
                disabled={working}
                onCheckedChange={checked => { void act({ operation: 'configure', enabled: checked, watched: install.watched }) }}
              />
            </SettingRow>
            <SettingRow title={t('watch')} description={t('watchNote')}>
              <Button type="button" variant="outline" size="sm" aria-expanded={selecting} onClick={() => setSelecting(!selecting)}>
                {t('choose')}
              </Button>
            </SettingRow>
            {selecting && status.channels.length === 0 && !result.isLoading ? (
              <SettingRow title={t('empty')} />
            ) : null}
            {selecting ? status.channels.map(channel => {
              const watched = install.watched.includes(channel.id)
              const actionText = t(watched ? 'selected' : 'unselected')
              return (
                <SettingRow key={channel.id} title={`#${channel.name}`}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={working}
                    aria-pressed={watched}
                    aria-label={t('toggle', { action: actionText, channel: channel.name })}
                    onClick={() => {
                      void act({
                        operation: 'configure',
                        enabled: install.enabled,
                        watched: watched ? install.watched.filter(id => id !== channel.id) : [...install.watched, channel.id],
                      })
                    }}
                  >
                    {actionText}
                  </Button>
                </SettingRow>
              )
            }) : null}
          </>
        ) : null}

        {install?.canUninstall ? (
          <SettingRow title={t('uninstall')}>
            <Button type="button" variant="destructive" size="sm" disabled={working} onClick={() => setConfirmOp('uninstall')}>
              {t('uninstall')}
            </Button>
          </SettingRow>
        ) : null}
      </SettingsSection>

      {slackAccounts.length > 0 ? (
        <SettingsSection id="slack-composio-accounts" title="Slack OAuth">
          {slackAccounts.map(acc => (
            <SettingRow key={acc.id} title={acc.alias ?? acc.email ?? 'Slack'}>
              <Badge tone={acc.enabled ? 'success' : 'neutral'}>
                {acc.enabled ? t('selected') : t('disable')}
              </Badge>
            </SettingRow>
          ))}
        </SettingsSection>
      ) : null}

      <AlertDialog open={confirmOp !== null} onOpenChange={open => { if (!open && !working) setConfirmOp(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmOp ? t(confirmOp) : ''}</AlertDialogTitle>
            <AlertDialogDescription>{confirmOp === 'unlink' ? t('unlinkConfirm') : t('uninstallConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={working}
              onClick={event => {
                event.preventDefault()
                if (!confirmOp) return
                void act({ operation: confirmOp }).then(ok => { if (ok) setConfirmOp(null) })
              }}
            >
              {confirmOp ? t(confirmOp) : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ========================================================================== */
/* Shared Store & Skills Search Hooks                                         */
/* ========================================================================== */

export function useSkillsSearch(query: string, enabled: boolean) {
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim())
  const trimmedQuery = query.trim()
  const shortQuery = trimmedQuery.length === 1
  const queryReady = trimmedQuery === debouncedQuery && !shortQuery
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 300)
    return () => window.clearTimeout(timeout)
  }, [trimmedQuery])
  const { data: pages, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite(
    (index, previous: SkillsPage | null) => !enabled || !queryReady || (previous && !previous.hasMore) ? null : ['/api/skills/search', debouncedQuery, index] as const,
    fetchSkills,
    { shouldRetryOnError: false, revalidateFirstPage: false },
  )
  const skills = pages?.flatMap(page => page.data)
  const hasMore = Boolean(pages?.at(-1)?.hasMore)
  const loadingMore = Boolean(pages) && size > pages!.length && !error
  /** Put on an element at the list's end: reaching it loads the next page. */
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = moreRef.current
    if (!sentinel || !hasMore || loadingMore || error) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void setSize(current => current + 1) }, { rootMargin: '400px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, error, setSize, pages?.length])
  return { skills, error, isLoading, isValidating, retry: () => void mutate(), hasMore, loadingMore, moreRef, trimmedQuery, shortQuery, queryReady }
}

/**
 * The 应用 store's data: its sections (热门 with ours first, 新品推荐, then Composio's categories), the open section
 * (`&category=`), search results, what 添加 offers, each item's state and what connecting it does. Shared with UI layers.
 */
export function usePluginStore({ apps, ownRead, category, query, go }: { apps: ConnectedApps; ownRead: OwnAppsRead; category: string | null; query: string; go: PluginsGo }) {
  const t = useTranslations('Plugins')
  const info = useAppInfo()
  const catalog = useStoreCatalog()
  const [keyTarget, setKeyTarget] = useState<CredentialTarget | null>(null)
  const trimmedQuery = query.trim()
  const store = catalog.data?.apps ?? []
  const byId = new Map<string, StoreApp>(store.map(item => [item.id, item]))
  const own: StoreEntry[] = OWN_APPS.map(id => ({ id, ...info(id), description: t(`ownDescription.${id}`) }))
  if (!byId.has('slack')) own.push({ id: 'slack', ...info('slack'), description: t('ownDescription.slack') })
  const entries = (ids: readonly string[]): StoreEntry[] => ids.flatMap(id => { const item = byId.get(id); return item ? [{ id, name: item.name, description: item.description, iconUrl: item.iconUrl, connect: item.connect, credentialAlternative: findCredentialAlternative(item, store) }] : [] })
  const stateOf = (id: string): StoreItemState | null => id === 'slack' && !byId.has(id) ? 'add' : isOwnApp(id)
    ? ownRead.data?.failed.includes(id) && ownRead.data.states[id] === undefined ? 'unavailable' : storeItemState({ kind: 'own', state: ownRead.data?.states[id] })
    : storeItemState({ kind: 'composio', connect: byId.get(id)?.connect, accounts: apps.accountsFor(id).length, canLink: byId.get(id)?.connect === 'credentials' ? apps.canEnterKey : apps.canLink, loading: apps.loading })
  const sections: StoreSectionData[] = [
    { id: 'popular', name: t('popular'), items: [...own, ...entries(catalog.data?.popular ?? [])], preview: SECTION_PREVIEW },
    ...catalog.data ? [
      { id: 'latest', name: t('latest'), items: entries(catalog.data.latest), preview: SECTION_PREVIEW },
      ...catalog.data.categories.map(item => ({ id: `c:${item.id}`, name: item.name, items: entries(item.apps), preview: CATEGORY_PREVIEW })),
    ] : [],
  ].filter(item => item.items.length)
  const openSection = sections.find(item => item.id === category) ?? null
  const results = trimmedQuery ? [...own, ...entries(store.map(item => item.id))].filter(item => matchesStoreQuery(item, trimmedQuery)) : null
  const addable = [...own, ...entries(catalog.data?.popular ?? [])].filter(item => stateOf(item.id) === 'add')
  function connect(id: string) {
    if (isOwnApp(id) || id === 'slack') go({ app: id, category })
    else if (byId.get(id)?.connect === 'credentials') setKeyTarget({ app: id })
    else void apps.connect(id)
  }
  return { catalog, sections, openSection, results, addable, stateOf, connect, keyTarget, setKeyTarget }
}
