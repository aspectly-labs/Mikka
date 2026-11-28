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
  /** Stable receipt ID for one host-authorized BYOK web search tool call. */
  byokWebSearchId?: string
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
interface GateEntry { at: number; promise: Promise<unknown> }
export const decisionBatchCache = new AsyncLocalStorage<Map<string, GateEntry>>()
/** Even inside a long batch an admission/payer snapshot may not be reused for
 * more than a minute; a revoked policy or drained payer is picked up again. */
export const DECISION_GATE_TTL_MS = 60_000

/** Run `load` once per batch for `key`; outside a batch every call loads. A
 * rejection or an entry older than DECISION_GATE_TTL_MS is evicted so a later
 * call in the same batch still retries. */
export function cachedDecisionGate<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = decisionBatchCache.getStore()
  if (!store) return load()
  const hit = store.get(key)
  if (hit && Date.now() - hit.at <= DECISION_GATE_TTL_MS) return hit.promise as Promise<T>
  const promise = load()
  store.set(key, { at: Date.now(), promise })
  promise.catch(() => { if (store.get(key)?.promise === promise) store.delete(key) })
  return promise
}

/** Drop a cached gate inside the current batch (e.g. a payer that ran dry). */
export function forgetDecisionGate(key: string): void {
  decisionBatchCache.getStore()?.delete(key)
}
