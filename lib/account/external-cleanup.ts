import 'server-only'
import type { Pool } from 'pg'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { getComposio, retireComposioAccount } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { cleanupErrorIdentifier, type AccountCleanupReport, type AccountDeletionLease } from './cleanup-result'
import { cleanupAccountSubscriptions } from './subscription-cleanup'
import { cleanupAccountBilling } from './billing-cleanup'
import { cleanupAccountRuntimes } from './runtime-cleanup'

/**
 * No provider contents are deleted. Managed authorization must be revoked before its local mapping goes.
 * `soloWorkspaceIds` are the workspaces this deletion removes (Plan.solo); their paid plans must be
 * cancelled here, before the delete path takes the only entry point that could cancel them.
 */
export async function cleanupAccountConnections(ownerId: string, database: Pool, job?: AccountDeletionLease, soloWorkspaceIds: readonly string[] = []): Promise<AccountCleanupReport> {
  // Remote adapters resolve custody/key material through the current server scope.
  // A restore or caller-supplied SQL target must use explicit adapters, never ambient remote credentials.
  if (database.options.connectionString !== pool.options.connectionString || database.options.options !== pool.options.options) return { blockedReasons: ['external_cleanup_target_mismatch'], warnings: [] }
  const blocked: string[] = [], warnings: string[] = []
  // Billing goes first: a card that keeps being charged outlives every local row this job removes.
  const billing = await cleanupAccountBilling(database, { soloWorkspaceIds })
  blocked.push(...billing.blockedReasons); warnings.push(...billing.warnings)
  const cached = (await database.query('SELECT "accountId" FROM composio_accounts WHERE "userId"=$1', [ownerId])).rows
  const composio = getComposio()
  if (!composio && cached.length) blocked.push('composio_not_configured')
  if (composio) {
    const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [ownerId], cursor }))
    // Listing is scoped by the trusted provider's owner filter, never caller IDs.
    for (const account of accounts) await retireComposioAccount(composio, ownerId, account.id, 'disconnect')
    if (accounts.length) warnings.push('composio_upstream_revocation_may_complete_asynchronously')
  }
  const subscription = await cleanupAccountSubscriptions(ownerId, database, undefined, job)
  blocked.push(...subscription.blockedReasons); warnings.push(...subscription.warnings)
  const blockerErrors = { ...subscription.blockerErrors }
  if (isCloudEdition()) {
    const external = await database.query("SELECT 1 FROM e2b_resource_accounts WHERE \"ownerId\"=$1 AND scope='personal' LIMIT 1", [ownerId])
    if (external.rowCount) warnings.push('e2b_external_resources_managed_at_provider')
  }
  blocked.push(...await cleanupAccountRuntimes(ownerId, database, { job, blockerErrors }))
  try {
    const { cleanupOwnerEnvironmentSnapshots } = await import('@/lib/project-resources/environment-snapshot-build')
    await cleanupOwnerEnvironmentSnapshots(ownerId, soloWorkspaceIds)
  } catch (error) {
    blocked.push('cloud_snapshot_cleanup_required')
    blockerErrors.cloud_snapshot_cleanup_required = cleanupErrorIdentifier(error)
  }
  return { blockedReasons: [...new Set(blocked)], warnings: [...new Set(warnings)], ...(Object.keys(blockerErrors).length ? { blockerErrors } : {}) }
}
