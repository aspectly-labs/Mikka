'use server'

import { withFreshSession } from '@/lib/fresh-session'
import { pool } from '@/lib/db'
import { requireUser } from '@/lib/issue-access'
import type { ApiKeyView } from '@/lib/model-api-key-providers'
import { addApiKey, apiKeyOwnerOf, listApiKeys, refreshApiKeyDaybreak, refreshApiKeyModels, removeApiKey, setApiKeyAfterQuota, setApiKeyFeatures, setApiKeyWebSearch, updateApiKey as updateStoredApiKey, usableApiKeys, type ApiKeyDaybreakRefreshResult, type ApiKeyOwner, type ApiKeysPage, type UsableApiKey } from '@/lib/model-api-keys'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

// 设置 › 模型: the signed-in person's own API keys and custom providers (你的连接), and
// the workspace's own keys (工作区连接), which a team workspace's admins add and manage.
// A person's key is never shared into a workspace (decision 2026-11-27-1740).
// Keys are write-only; every read carries the last four characters only.
// `workspaceId` is the workspace the settings page shows.

async function actor(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId || undefined, user)
  return { userId: user.id, workspace: context.workspace, admin: context.workspace.kind === 'team' && context.role === 'admin' }
}
type Actor = Awaited<ReturnType<typeof actor>>

/** A team workspace's own keys need its admin; a person's own keys need only that person. */
function workspaceOwner(current: Actor): ApiKeyOwner {
  if (current.workspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
  if (!current.admin) throw new WorkspaceError('workspaceAccessDenied')
  return { workspaceId: current.workspace.id }
}

/** Whose key an id names, for this actor: their own, or this workspace's (admins only). Anything else is not found. */
async function ownerForKey(current: Actor, id: string): Promise<ApiKeyOwner> {
  const key = await apiKeyOwnerOf(pool, id)
  if (key?.workspaceId && key.workspaceId === current.workspace.id) return workspaceOwner(current)
  return { userId: current.userId }
}

/** The workspace's own keys for a member who cannot manage them, labelled with the workspace's name. */
async function readWorkspaceKeys(current: Actor): Promise<(UsableApiKey & { ownerName: string })[]> {
  if (current.workspace.kind !== 'team' || current.admin) return []
  return (await usableApiKeys(pool, current.userId, current.workspace.id)).filter(key => key.workspace)
    .map(key => ({ ...key, ownerName: current.workspace.name }))
}

async function readApiKeysPage(current: Actor): Promise<ApiKeysPage> {
  const [page, sharedKeys] = await Promise.all([
    listApiKeys(pool, current.userId, current.workspace, { admin: current.admin }),
    readWorkspaceKeys(current),
  ])
  return { ...page, sharedKeys }
}

export async function getApiKeys(workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => readApiKeysPage(await actor(workspaceId)))
}

/**
 * 添加连接. `share: true` is the hosted page's 添加工作区连接 (one-release name):
 * it adds a key owned by the workspace, by one of its admins. It never shares a
 * person's key.
 */
async function createApiKeyBody(input: unknown, workspaceId?: string, options?: { share?: boolean }): Promise<SettingsActionResult<ApiKeyView>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    if (options?.share) return addApiKey(pool, workspaceOwner(current), input, { addedBy: current.userId })
    return addApiKey(pool, current.userId, input)
  })
}

async function updateApiKeyBody(id: string, input: unknown, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    await updateStoredApiKey(pool, await ownerForKey(current, id), id, input)
    return readApiKeysPage(current)
  })
}

async function deleteApiKeyBody(id: string, workspaceId?: string): Promise<SettingsActionResult<{ removed: boolean }>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    return removeApiKey(pool, await ownerForKey(current, id), id)
  })
}

/** 重新获取模型 for one key; the page's list comes back with the result or the reason. */
async function refetchApiKeyModelsBody(id: string, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    await refreshApiKeyModels(pool, await ownerForKey(current, id), id)
    return readApiKeysPage(current)
  })
}

/** Refreshes OpenAI Trusted Access for Cyber (Daybreak) grants for one of the person's own API keys (#3315). */
export async function refreshApiKeyDaybreakAction(id: string, workspaceId?: string): Promise<SettingsActionResult<ApiKeyDaybreakRefreshResult & { page: ApiKeysPage }>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    const refreshed = await refreshApiKeyDaybreak(pool, current.userId, id)
    const page = await readApiKeysPage(current)
    return { ...refreshed, page }
  })
}

/**
 * Retired (decision 2026-11-27-1740): a person's key cannot move into a
 * workspace, nor a workspace's key to a person. Kept one release for the hosted
 * page's 移到工作区连接 / 移到你的连接 menu; it answers the conflict code
 * `apiKeySharingRetired` after the usual session checks and changes nothing.
 */
async function updateApiKeyShareBody(_input: { id: string; shared: boolean }, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    await actor(workspaceId)
    throw new WorkspaceError('apiKeySharingRetired')
  })
}

export async function updateApiKeyAfterQuota(on: boolean, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    await setApiKeyAfterQuota(pool, current.userId, on)
    return readApiKeysPage(current)
  })
}

export async function updateApiKeyWebSearch(on: boolean, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return withFreshSession(() => settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    await setApiKeyWebSearch(pool, current.userId, on)
    return readApiKeysPage(current)
  }))
}

/** Turns off request features a custom provider rejects (decision 2026-11-15-2000). Owner only (a workspace key's admins). */
async function updateApiKeyFeaturesBody(id: string, features: import('@/lib/model-gateway/features').GatewayFeatures, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const current = await actor(workspaceId)
    await setApiKeyFeatures(pool, await ownerForKey(current, id), id, features)
    return readApiKeysPage(current)
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function createApiKey(...args: Parameters<typeof createApiKeyBody>) { return withFreshSession(() => createApiKeyBody(...args)) }
export async function updateApiKey(...args: Parameters<typeof updateApiKeyBody>) { return withFreshSession(() => updateApiKeyBody(...args)) }
export async function deleteApiKey(...args: Parameters<typeof deleteApiKeyBody>) { return withFreshSession(() => deleteApiKeyBody(...args)) }
export async function updateApiKeyShare(...args: Parameters<typeof updateApiKeyShareBody>) { return withFreshSession(() => updateApiKeyShareBody(...args)) }
export async function refetchApiKeyModels(...args: Parameters<typeof refetchApiKeyModelsBody>) { return withFreshSession(() => refetchApiKeyModelsBody(...args)) }
export async function updateApiKeyFeatures(...args: Parameters<typeof updateApiKeyFeaturesBody>) { return withFreshSession(() => updateApiKeyFeaturesBody(...args)) }
