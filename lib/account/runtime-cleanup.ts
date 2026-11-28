import 'server-only'
import type { Pool } from 'pg'
import { cleanupOwnedCloudMachines } from './cloud-cleanup'
import { isExternalE2BResource } from './e2b-external-custody'
import { retrySandboxKills } from '@/lib/cloud-computer/workspace-teardown'
import { cleanupErrorIdentifier, type AccountCleanupOptions } from './cleanup-result'

export type EndAccountThread = (database: Pool, actor: { userId: string; workspaceId: string }, runId: string) => Promise<void>
const end: EndAccountThread = async (database, actor, runId) => {
  const { threadMachineAction } = await import('@/lib/cloud-computer/thread-machines')
  try { await threadMachineAction(database, actor, runId, 'end') }
  catch (error) {
    const { SandboxNotFoundError } = await import('e2b')
    if (!(error instanceof SandboxNotFoundError)) throw error
  }
}
/** Called only by the authorized owner's deletion job, before any runtime mapping is erased. */
export async function cleanupAccountRuntimes(ownerId: string, database: Pool, endThreadOrOptions: EndAccountThread | AccountCleanupOptions = end, cleanupCloud = cleanupOwnedCloudMachines,
  retryKills = (owner: string, target: Pool) => retrySandboxKills(target, {
    ownerId: owner, limit: 1000,
    kill: async (resourceOwner, sandboxId) => {
      if (await isExternalE2BResource(resourceOwner, 'sandbox', sandboxId, target)) return
      const { threadMachineProvider } = await import('@/lib/cloud-computer/thread-machines')
      await threadMachineProvider.kill(sandboxId, resourceOwner)
    },
  })): Promise<string[]> {
  const endThread = typeof endThreadOrOptions === 'function' ? endThreadOrOptions : end
  const options = typeof endThreadOrOptions === 'function' ? {} : endThreadOrOptions
  const reasons = new Set<string>()
  // Sandboxes of deleted workspaces still waiting for a kill: only this person's key can kill them, and it goes with the account.
  try { if ((await retryKills(ownerId, database)).pending) reasons.add('cloud_sandbox_kill_pending') }
  catch { reasons.add('cloud_sandbox_kill_pending') }
  const threads = (await database.query<{ runId: string; workspaceId: string; sandboxId: string | null;
    filesystemSnapshotId: string | null; operationId: string; snapshotId: string }>(
    `SELECT "runId","workspaceId","sandboxId","filesystemSnapshotId","operationId","snapshotId" FROM thread_machines WHERE "ownerId"=$1
    AND ("sandboxId" IS NOT NULL OR state<>'ended' OR "workerLeaseId" IS NOT NULL OR "workerLeaseUntil" IS NOT NULL) ORDER BY "runId"`, [ownerId])).rows
  for (const thread of threads) {
    try {
      // The account guard already fences new work. Main-store deletion removes
      // local access; a confirmed legacy E2B account retains its external objects.
      const resources = [
        ['operation', thread.operationId],
        ['sandbox', thread.sandboxId],
        ['snapshot', thread.filesystemSnapshotId],
      ] as const
      const external = options.job && thread.snapshotId !== 'cloudflare-task-v1' && (await Promise.all(
        resources.map(([kind, id]) => id ? isExternalE2BResource(ownerId, kind, id, database) : true),
      )).every(Boolean)
      if (!external) await endThread(database, { userId: ownerId, workspaceId: thread.workspaceId }, thread.runId)
    }
    catch (error) {
      reasons.add('cloud_thread_cleanup_pending')
      if (options.blockerErrors) options.blockerErrors.cloud_thread_cleanup_pending = cleanupErrorIdentifier(error)
    }
  }
  for (const reason of await cleanupCloud(ownerId, database, undefined, options)) reasons.add(reason)
  // A prior close can fail before a successful VM kill. Drain again while
  // the owner's provider key still exists, including already deleted sources.
  // Pending ACKs must not outlive deletion of the key needed to prove VM loss.
  try {
    const { revokeReviewSessions } = await import('../coding-workspace/review-sessions')
    if ((await revokeReviewSessions(database, { userId: ownerId }, 'credential_revoked')).pending) reasons.add('review_capability_close_pending')
  } catch { reasons.add('review_capability_close_pending') }
  return [...reasons]
}
