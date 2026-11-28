import { isSnapshotReadFetcher, snapshotReadFetcher } from './read-observer'

declare const KEYED_FETCHER_BRAND: unique symbol

export type SwrTupleKey = readonly [string, ...unknown[]]
export type SwrKey = string | SwrTupleKey

/**
 * A nominally branded SWR fetcher whose accepted key shape `K` and resolved
 * value `Data` are verified independently of SWR's permissive `BareFetcher`
 * fallback overload.
 */
export type KeyedFetcher<K extends SwrKey, Data> = ((key: K) => Promise<Data>) & {
  readonly [KEYED_FETCHER_BRAND]: (key: K) => Data
}

/**
 * Constrains `F` to functions that take zero declared parameters (including no
 * optional parameters). Passing `listBots(workspaceId?: string)` fails to
 * compile instead of silently letting SWR pass the cache key as `workspaceId`.
 */
export type ZeroArgAsyncFn<F> = F extends (...args: infer Args) => Promise<unknown>
  ? Args extends []
    ? F
    : never
  : never

const typedFetchers = new WeakSet<object>()

function markTypedFetcher<K extends SwrKey, Data>(
  fn: (key: K) => Promise<Data>,
  preserveSnapshotFrom?: object,
): KeyedFetcher<K, Data> {
  if (preserveSnapshotFrom && isSnapshotReadFetcher(preserveSnapshotFrom)) {
    snapshotReadFetcher(fn as (...args: never[]) => unknown)
  }
  typedFetchers.add(fn)
  return fn as KeyedFetcher<K, Data>
}

export function isTypedFetcher(value: unknown): boolean {
  return typeof value === 'function' && typedFetchers.has(value)
}

/**
 * Declare a typed key-to-request SWR fetcher. Use this whenever a reusable
 * fetcher reads parameters from the SWR cache key (`string` or `readonly [string, ...]`).
 */
export function keyedFetcher<K extends SwrKey, Data>(
  fn: (key: K) => Promise<Data>,
): KeyedFetcher<K, Data> {
  return markTypedFetcher(fn, fn)
}

/**
 * Declare a typed URL-string SWR fetcher. Forwards only the URL string key
 * (never extra arguments), preventing multi-arg helpers like `request(url, body?)`
 * from accidentally interpreting extra arguments as a request body.
 */
export function urlFetcher<Data>(
  fn: (url: string) => Promise<Data>,
): KeyedFetcher<string, Data> {
  return markTypedFetcher<string, Data>(url => fn(url), fn)
}

/**
 * Wrap a zero-argument read (such as a server action or local loader) for SWR
 * so the cache key is NEVER forwarded as an argument at runtime and any
 * optional/required parameter on the target function is rejected at compile time.
 */
export function noArgFetcher<F extends () => Promise<unknown>>(
  fn: ZeroArgAsyncFn<F>,
): KeyedFetcher<SwrKey, Awaited<ReturnType<F>>> {
  const wrapped = () => (fn as () => Promise<Awaited<ReturnType<F>>>)()
  return markTypedFetcher<SwrKey, Awaited<ReturnType<F>>>(wrapped, fn)
}

export { noArgFetcher as actionFetcher }
