import type { Cache, Key, useSWRConfig } from 'swr'
import { prefetchScopedRead } from '@/lib/swr/prefetch'

const loadTaskDetail = () => import('./task-detail')
export const loadAutomations = () => import('@/components/automations/automations-section').then(module => module.AutomationsSection)
export const loadCoordinator = () => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat)
export const loadSettings = () => import('@/components/settings/settings-shell').then(module => module.SettingsRouteContent)

const loaders = { task: loadTaskDetail, automations: loadAutomations, coordinator: loadCoordinator, settings: loadSettings }
export type WorkspacePage = keyof typeof loaders

type ScopedMutate = ReturnType<typeof useSWRConfig>['mutate']
/** Where a page's speculative reads go: the open workspace's own cache, and the workspace they are scoped to. */
export type WorkspacePageReads = { cache: Cache; mutate: ScopedMutate; workspaceId: string }

const reads: Partial<Record<WorkspacePage, (scope: WorkspacePageReads) => [Key, () => Promise<unknown>][]>> = {}

/** Start the same module import used by the destination without mounting it, and its first reads beside it. */
export function preloadWorkspacePage(page: WorkspacePage, scope?: WorkspacePageReads) {
  void loaders[page]().catch(() => {})
  if (!scope) return
  for (const [key, read] of reads[page]?.(scope) ?? []) void prefetchScopedRead(scope.cache, scope.mutate, key, read)
}

export function preloadTaskDetail() { preloadWorkspacePage('task') }
