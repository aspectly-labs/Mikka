import { AsyncLocalStorage } from 'node:async_hooks'
/** Server-owned billing identity for non-Workflow model consumers. */
export const hostedBillingScope = new AsyncLocalStorage<{
  workspaceId: string
  ownerId?: string
  workspaceIds?: string[]
  /** Selected for one admission; preserved in the receipt independently from the source workspace. */
  billingAccountWorkspaceId?: string
  billingOrganizationId?: string | null
  creditShareOwnerId?: string
  actorId?: string | null
  projectId?: string | null
  threadId?: string | null
  runId?: string | null
  /** The conversation turn the call serves (lib/usage-turn-ref.ts); stored as hosted_usage."usageTurnRef". */
  turnRef?: string | null
  billingSource?: 'credits'
  /** True only after server authorization established each resource binding. */
  attributionComplete?: boolean
}>()

/**
 * Read-only admission gates (model admission, paid-use check, shared-credit
 * principal) repeat identical queries for every Decisions call inside one
 * batched task. A batch of notifications asks the same workspace the same
 * questions within seconds; this scope memoizes those loads for the batch's
 * lifetime. Writes (reserve/settle) still run per call.
 */
export const decisionBatchCache = new AsyncLocalStorage<Map<string, Promise<unknown>>>()

/** Run `load` once per batch for `key`; outside a batch every call loads. A
 * rejection is evicted so a later call in the same batch still retries. */
export function cachedDecisionGate<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = decisionBatchCache.getStore()
  if (!store) return load()
  let hit = store.get(key) as Promise<T> | undefined
  if (!hit) {
    hit = load()
    store.set(key, hit)
    hit.catch(() => { if (store.get(key) === hit) store.delete(key) })
  }
  return hit
}
