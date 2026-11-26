import type { PoolClient } from 'pg'
import 'server-only'
import { createPrepaidE2B, releaseInterruptedE2BCreation, E2B_TIMEOUT_REQUEST_BUDGET_MS, e2bCreationTimeout, verifyE2BAllocation,
  prepareE2BProviderTime, isLegacyE2BThreadAllocation, recordE2BComputeSnapshot, e2bSnapshotComputeTemplate } from './e2b-compute-billing'
import { bindE2BResource, e2bCreateAccount, e2bResourceAccount } from '@/lib/secrets/e2b-resource'
import { NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b'
import { environmentSnapshotScope, withE2BErrors } from '@/lib/secrets/e2b-runtime'
import { E2BKeyError } from '@/lib/secrets/flag'

const options = (apiKey: string) => ({
  apiKey,
  proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
  requestTimeoutMs: 15_000,
})

export type ThreadProviderInfo = { state: 'running' | 'paused' | 'missing'; endAt: number | null }
export type ThreadCreatedSandbox = { sandboxId: string; state: 'running' | 'paused'; startedAt: number; endAt: number | null }
export type ThreadSnapshotInfo = { snapshotId: string; names: string[] }

/** A kill switch, not a feature flag branch: snapshots become reachable only
 * when the operator opts in, because E2B documents no price or retention. */
export function threadSnapshotsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MIKKA_THREAD_SNAPSHOTS === '1'
}

/** Deterministic per-run name. A lost create ACK is reconciled by listing this
 * exact name; the name is never reused by another run or task. */
export function threadSnapshotName(runId: string): string {
  return `mikka-thread-${runId.replaceAll('-', '')}`
}

const snapshotIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
/** Filesystem-only snapshots can be disabled per team or unsupported by an
 * older node; a full snapshot still works in both documented cases. */
const filesystemSnapshotUnavailable = (error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  return /snapshot_filesystem_only_(disabled|unsupported_node)/.test(message)
}

/** Maintenance must never connect: E2B connect resumes a paused VM. These
 * control-plane operations observe, snapshot or extend an already running
 * machine. Snapshots exist only on the owner's own key. */
export const threadLifecycleProvider = {
  async findCreated(runId: string, workspaceId: string, operationId: string, ownerId: string): Promise<ThreadCreatedSandbox | null> {
    if (await releaseInterruptedE2BCreation(ownerId, operationId)) return null
    const metadata = { application: 'mikka-thread', workspaceId, runId, operationId }
    const account = await e2bResourceAccount(ownerId, 'operation', operationId)
    const pages = Sandbox.list({ ...options(account.apiKey), limit: 2, query: { metadata, state: ['running', 'paused'] } })
    const found = await pages.nextItems()
    // An allocation is unique to the persisted operation. Ambiguous, partial
    // or mismatched results require reconciliation; none authorizes a kill.
    if (found.length > 1 || pages.hasNext || found.some(item => Object.entries(metadata).some(([key, value]) => item.metadata[key] !== value)))
      throw new Error('Thread allocation identity unavailable')
    const item = found[0]
    if (!item) return null
    const prepared = options(account.apiKey)
    let state = item.state
    if (await isLegacyE2BThreadAllocation(ownerId, workspaceId, runId, operationId, account.scope, item)) {
      if (state === 'running') {
        // An installation-owned historical sandbox must stop using compute
        // until the next duly funded wake. Never debit this old interval.
        const paused = await Sandbox.pause(item.sandboxId, { ...prepared, retries: 0 })
        if (!paused) throw new E2BKeyError('e2b_unavailable', 'Historical thread pause was not confirmed')
        state = 'paused'
      }
    } else {
      await verifyE2BAllocation(ownerId, operationId, item.sandboxId, prepared, item)
    }
    await bindE2BResource(ownerId, 'sandbox', item.sandboxId, account.scope)
    return { sandboxId: item.sandboxId, state, startedAt: item.startedAt.getTime(),
      endAt: state === 'paused' ? null : item.endAt.getTime() }
  },
  async info(sandboxId: string, ownerId: string): Promise<ThreadProviderInfo> {
    try {
      const info = await Sandbox.getInfo(sandboxId, options((await e2bResourceAccount(ownerId, 'sandbox', sandboxId)).apiKey))
      return { state: info.state === 'paused' ? 'paused' : 'running', endAt: info.state === 'paused' ? null : info.endAt.getTime() }
    } catch (error) {
      const status = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined
      if (error instanceof SandboxNotFoundError || error instanceof NotFoundError || status === 404) return { state: 'missing', endAt: null }
      throw error
    }
  },
  async prepareKeepAlive(sandboxId: string, ownerId: string, timeoutMs: number, renew = true) {
    const account = await e2bResourceAccount(ownerId, 'sandbox', sandboxId)
    const prepared = options(account.apiKey)
    const intent = await prepareE2BProviderTime(ownerId, sandboxId, timeoutMs, {
      providerScope: account.scope,
      inspect: () => withE2BErrors(ownerId, false, () => Sandbox.getInfo(sandboxId, prepared)),
    }, renew)
    return {
      begin: intent.begin,
      async apply(client: Pick<PoolClient, 'query'>) {
        const applied = await intent.apply(client, duration => Sandbox.setTimeout(sandboxId, duration, {
          ...prepared, requestTimeoutMs: E2B_TIMEOUT_REQUEST_BUDGET_MS, retries: 0,
        }))
        return applied?.deadline ?? null
      },
      cancel: intent.cancel,
    }
  },
  /** Snapshot the task's filesystem. The sandbox may be left paused by E2B;
   * the caller's pause is idempotent. */
  async createSnapshot(sandboxId: string, ownerId: string, name: string): Promise<ThreadSnapshotInfo> {
    const account = await e2bResourceAccount(ownerId, 'sandbox', sandboxId)
    const prepared = options(account.apiKey)
    let info
    try {
      info = await withE2BErrors(ownerId, false, () => Sandbox.createSnapshot(sandboxId, { ...prepared, name, mode: 'filesystem' }))
    } catch (error) {
      if (!filesystemSnapshotUnavailable(error)) throw error
      info = await withE2BErrors(ownerId, false, () => Sandbox.createSnapshot(sandboxId, { ...prepared, name }))
    }
    await bindE2BResource(ownerId, 'snapshot', info.snapshotId, account.scope)
    await recordE2BComputeSnapshot(ownerId, sandboxId, info.snapshotId)
    return { snapshotId: info.snapshotId, names: info.names }
  },
  /** Reconcile a snapshot whose create response was lost. Exact per-run name:
   * two matches are ambiguous and never authorize adoption. */
  async listSnapshots(sandboxId: string, ownerId: string, name: string): Promise<ThreadSnapshotInfo[]> {
    const account = await e2bResourceAccount(ownerId, 'sandbox', sandboxId)
    const prepared = options(account.apiKey)
    const pages = Sandbox.listSnapshots({ ...prepared, sandboxId, name })
    const rows: ThreadSnapshotInfo[] = []
    while (pages.hasNext) rows.push(...(await pages.nextItems(prepared)).map(item => ({ snapshotId: item.snapshotId, names: item.names })))
    for (const row of rows) {
      await bindE2BResource(ownerId, 'snapshot', row.snapshotId, account.scope)
      await recordE2BComputeSnapshot(ownerId, sandboxId, row.snapshotId)
    }
    return rows
  },
  async deleteSnapshot(snapshotId: string, ownerId: string): Promise<boolean> {
    const prepared = options((await e2bResourceAccount(ownerId, 'snapshot', snapshotId)).apiKey)
    return withE2BErrors(ownerId, false, () => Sandbox.deleteSnapshot(snapshotId, prepared))
  },
  /** Restore from a snapshot on the same owner's key. The snapshot is written
   * only by this module for this task's machine; no template-origin check is
   * applicable to an owner-created snapshot. */
  async createFromSnapshot(snapshotId: string, operationId: string, metadata: Record<string, string>, ownerId: string, environmentTemplate?: string) {
    if (!snapshotIdPattern.test(snapshotId)) throw new Error('Thread filesystem snapshot unavailable')
    const scope = environmentTemplate ? environmentSnapshotScope() : (await e2bResourceAccount(ownerId, 'snapshot', snapshotId)).scope
    const account = await e2bCreateAccount(ownerId, operationId, scope)
    const template = environmentTemplate ?? await e2bSnapshotComputeTemplate(ownerId, snapshotId)
    if (template === null) throw new E2BKeyError('e2b_template_unavailable', 'E2B snapshot has no verified compute record')
    const timeoutMs = await e2bCreationTimeout(ownerId, account.scope, operationId, template, { workspaceId: metadata.workspaceId, runId: metadata.runId }, 15 * 60_000)
    const prepared = options(account.apiKey)
    const sandbox = await createPrepaidE2B(ownerId, operationId, () => withE2BErrors(ownerId, false, () => Sandbox.create(snapshotId, {
      ...prepared, retries: 0, idempotencyKey: operationId, timeoutMs, metadata,
      lifecycle: { onTimeout: 'pause', autoResume: false },
    })))
    await verifyE2BAllocation(ownerId, operationId, sandbox.sandboxId, prepared)
    await bindE2BResource(ownerId, 'sandbox', sandbox.sandboxId, account.scope)
    return sandbox
  },
}
