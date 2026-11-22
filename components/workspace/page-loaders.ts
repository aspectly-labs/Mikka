import type { Cache, Key, useSWRConfig } from 'swr'
import { prefetchScopedRead } from '@/lib/swr/prefetch'
import { botPermissionsKeys, chatKeys } from '@/lib/swr/keys'
import type { ChatTarget } from '@/components/nav/bot-list'

const loadTaskDetail = () => import('./task-detail')
export const loadAutomations = () => import('@/components/automations/automations-section').then(module => module.AutomationsSection)
export const loadCoordinator = () => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat)
export const loadSettings = () => import('@/components/settings/settings-shell').then(module => module.SettingsRouteContent)

const loaders = { task: loadTaskDetail, automations: loadAutomations, coordinator: loadCoordinator, settings: loadSettings }
export type WorkspacePage = keyof typeof loaders

type ScopedMutate = ReturnType<typeof useSWRConfig>['mutate']
/** Where a page's speculative reads go: the open workspace's own cache, and the workspace they are scoped to. */
export type WorkspacePageReads = { cache: Cache; mutate: ScopedMutate; workspaceId: string }

/**
 * The reads a page's first paint waits on, with the same keys and the same reads the page uses.
 * Only reads that can start without something the page itself has to read first belong here: 设置 ›
 * 应用与运行权限 reads the workspace's Bots, then that Bot's workspace policy, then the run policy,
 * and only the first of those three can be asked for before the section is mounted.
 *
 * The actions are imported here rather than at the top of the module: a preload is speculative and may
 * never run, and a top-level server-action import makes every host of this module carry it — including
 * the tests that mount the workspace with their own action mocks.
 */
const reads: Partial<Record<WorkspacePage, (scope: WorkspacePageReads, target?: ChatTarget) => [Key, () => Promise<unknown>][]>> = {
  // A Bot's chat (or the Coordinator's), pointed at in the sidebar: its first read, through the reader the chat
  // itself uses, so opening it finds the transcript in the cache (UX audit 2026-11-22 #3). Nothing reads without a target.
  coordinator: ({ cache }, target) => {
    const botId = target?.kind === 'bot' ? target.botId : target?.kind === 'coordinator' ? null : undefined
    if (botId === undefined) return []
    return [[chatKeys.detail(botId), () => import('@/lib/coordinator/chat-read-client').then(module => module.readCachedCoordinatorChat(cache, botId))]]
  },
  settings: ({ workspaceId }) => [
    [botPermissionsKeys.bots(workspaceId), () => import('@/app/actions/bots').then(module => module.listBotsForWorkspace(workspaceId))],
    [botPermissionsKeys.agents(), () => import('@/app/actions/agents').then(module => module.listAgents())],
  ],
}

/**
 * Start the same module import used by the destination without mounting it, and its first reads beside it.
 * `target` names the chat a Bot page opens. Settles when the chunk and the reads have (a failed read included:
 * the page reads again itself and shows why).
 */
export function preloadWorkspacePage(page: WorkspacePage, scope?: WorkspacePageReads, target?: ChatTarget): Promise<void> {
  const chunk = loaders[page]().then(() => {}, () => {})
  if (!scope) return chunk
  return Promise.all([chunk, ...(reads[page]?.(scope, target) ?? []).map(([key, read]) => prefetchScopedRead(scope.cache, scope.mutate, key, read))]).then(() => {})
}

export function preloadTaskDetail() { void preloadWorkspacePage('task') }
