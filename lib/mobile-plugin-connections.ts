import { getComposio } from '@/lib/composio'
import { toolkitAccountStates, type ToolkitState } from '@/lib/composio-account-state'
import { listComposioAccountRecords } from '@/lib/composio-account-store'
import { toConnectedAccountView, withAccountRecords } from '@/lib/composio-accounts'
import { listComposioPages } from '@/lib/composio-pagination'
import { GitHubAccessError, listAuthorizedRepositories } from '@/lib/github/user-access'
import { readTelegramIntegrationStatus } from '@/lib/telegram/connection-status'

async function github(userId: string, headers: Headers) {
  try {
    const result = await listAuthorizedRepositories(headers)
    if (result.userId !== userId) throw new GitHubAccessError('authRequired', 401)
    return result.installations.length ? ['github'] : []
  } catch (error) {
    if (error instanceof GitHubAccessError && (error.code === 'githubNotConnected' || error.code === 'githubNotConfigured')) return []
    throw error
  }
}

async function composioAccounts(userId: string) {
  const composio = getComposio()
  if (!composio) return {}
  const [rows, records] = await Promise.all([
    listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor })),
    listComposioAccountRecords(userId),
  ])
  const accounts = withAccountRecords(rows.flatMap(row => toConnectedAccountView(row) ?? []), records)
  return toolkitAccountStates(accounts)
}

export async function mobilePluginConnections(userId: string, headers: Headers) {
  const sources = ['composio', 'github', 'telegram'] as const
  const paused = ['linear']
  const states: Record<string, ToolkitState> = {}
  const reads = await Promise.allSettled([
    composioAccounts(userId).then(accounts => {
      Object.assign(states, accounts)
      return Object.keys(accounts)
    }),
    github(userId, headers),
    readTelegramIntegrationStatus(userId).then(state => state.configured && state.connected ? ['telegram'] : []),
  ])
  const toolkits = new Set<string>()
  const failed: { source: typeof sources[number]; reason: string }[] = []
  reads.forEach((read, index) => {
    if (read.status === 'fulfilled') for (const id of read.value) toolkits.add(id)
    else failed.push({ source: sources[index], reason: read.reason instanceof GitHubAccessError ? read.reason.code : read.reason instanceof Error ? read.reason.name : 'unknown' })
  })
  for (const id of toolkits) states[id] ??= 'active'
  return { toolkits: [...toolkits], states, paused, failed }
}
