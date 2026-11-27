'use server'

import { withFreshSession } from '@/lib/fresh-session'
import { and, eq, inArray } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireUser } from '@/lib/issue-access'
import type { ApiKeyView } from '@/lib/model-api-key-providers'
import { addApiKey, listApiKeys, refreshApiKeyDaybreak, refreshApiKeyModels, removeApiKey, setApiKeyAfterQuota, setApiKeyFeatures, setApiKeyShare, updateApiKey as updateStoredApiKey, usableApiKeys, type ApiKeyDaybreakRefreshResult, type ApiKeysPage, type UsableApiKey } from '@/lib/model-api-keys'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

// 设置 › API 与订阅: the signed-in person's own API keys and custom providers.
// Keys are write-only; every read carries the last four characters only.
// `workspaceId` is the workspace the settings page shows; 分享给团队成员 applies there.

async function actor(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId || undefined, user)
  return { userId: user.id, workspace: context.workspace }
}

async function resolveSharedKeys(userId: string, workspaceId: string): Promise<(UsableApiKey & { ownerName: string })[]> {
  const borrowed = (await usableApiKeys(pool, userId, workspaceId)).filter(key => !key.mine)
  if (!borrowed.length) return []
  const owners = [...new Set(borrowed.map(key => key.ownerId))]
  const members = await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, owners), eq(workspaceMembers.status, 'active')))
  const names = new Map(members.map(member => [member.userId, member.name]))
  return borrowed.filter(key => names.has(key.ownerId)).map(key => ({ ...key, ownerName: names.get(key.ownerId)! }))
}

async function readApiKeysPage(userId: string, workspace: { id: string; kind: 'personal' | 'team' }): Promise<ApiKeysPage> {
  const [page, sharedKeys] = await Promise.all([
    listApiKeys(pool, userId, workspace),
    workspace.kind === 'team' ? resolveSharedKeys(userId, workspace.id) : Promise.resolve([]),
  ])
  return { ...page, sharedKeys }
}

export async function getApiKeys(workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    return readApiKeysPage(userId, workspace)
  })
}

async function createApiKeyBody(input: unknown, workspaceId?: string, options?: { share?: boolean }): Promise<SettingsActionResult<ApiKeyView>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    return addApiKey(pool, userId, input, options?.share ? { shareWorkspace: workspace } : {})
  })
}

async function updateApiKeyBody(id: string, input: unknown, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await updateStoredApiKey(pool, userId, id, input)
    return readApiKeysPage(userId, workspace)
  })
}

async function deleteApiKeyBody(id: string, workspaceId?: string): Promise<SettingsActionResult<{ removed: boolean }>> {
  return settingsWorkspaceAction(async () => {
    const { userId } = await actor(workspaceId)
    return removeApiKey(pool, userId, id)
  })
}

/** 重新获取模型 for one of the person's keys; the page's list comes back with the result or the reason. */
export async function refetchApiKeyModels(id: string, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await refreshApiKeyModels(pool, userId, id)
    return readApiKeysPage(userId, workspace)
  })
}

/** Refreshes OpenAI Trusted Access for Cyber (Daybreak) grants for one owned API key (#3315). */
export async function refreshApiKeyDaybreakAction(id: string, workspaceId?: string): Promise<SettingsActionResult<ApiKeyDaybreakRefreshResult & { page: ApiKeysPage }>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    const refreshed = await refreshApiKeyDaybreak(pool, userId, id)
    const page = await readApiKeysPage(userId, workspace)
    return { ...refreshed, page }
  })
}

async function updateApiKeyShareBody(input: { id: string; shared: boolean }, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await setApiKeyShare(pool, userId, workspace, input.id, input.shared)
    return readApiKeysPage(userId, workspace)
  })
}

export async function updateApiKeyAfterQuota(on: boolean, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await setApiKeyAfterQuota(pool, userId, on)
    return readApiKeysPage(userId, workspace)
  })
}

/** Turns off request features a custom provider rejects (decision 2026-11-15-2000). Owner only. */
export async function updateApiKeyFeatures(id: string, features: import('@/lib/model-gateway/features').GatewayFeatures, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await setApiKeyFeatures(pool, userId, id, features)
    return readApiKeysPage(userId, workspace)
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function createApiKey(...args: Parameters<typeof createApiKeyBody>) { return withFreshSession(() => createApiKeyBody(...args)) }
export async function updateApiKey(...args: Parameters<typeof updateApiKeyBody>) { return withFreshSession(() => updateApiKeyBody(...args)) }
export async function deleteApiKey(...args: Parameters<typeof deleteApiKeyBody>) { return withFreshSession(() => deleteApiKeyBody(...args)) }
export async function updateApiKeyShare(...args: Parameters<typeof updateApiKeyShareBody>) { return withFreshSession(() => updateApiKeyShareBody(...args)) }
