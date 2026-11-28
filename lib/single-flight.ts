import 'server-only'
import { inDatabaseTransaction } from './db/request-scope'

/**
 * Identical concurrent reads on this instance share one database read.
 *
 * - The key is the read's name plus every input of its result: the
 *   authenticated user, the workspace and every authorization input the caller
 *   checked for this request (role, team scopes, ownership), and the read's own
 *   arguments. Two users or two workspaces never share a key.
 * - The caller authorizes each request before it joins; a shared result only
 *   ever reaches a request that passed its own check.
 * - Only while the read is in flight: there is no result TTL. A request that
 *   starts after the read settled reads again, so a revoke, membership change
 *   or delete is never served from here once its write has committed and the
 *   joining request's own authorization has seen it.
 * - Never inside a write transaction (its reads can see uncommitted writes).
 *
 * The shared value is the same object for every joiner: callers must not mutate it.
 */
const flights = new Map<string, Promise<unknown>>()
const scopedFlights = new WeakMap<object, Map<string, Promise<unknown>>>()
let joined = 0
let measuringWithout = false

export function singleFlight<T>(parts: readonly (string | number | boolean | null | undefined)[], read: () => Promise<T>, scope?: object): Promise<T> {
  if (measuringWithout || inDatabaseTransaction()) return read()
  // A request-routed database must supply its physical identity, never the
  // shared proxy. An in-flight read cannot cross database boundaries.
  let pending = scope ? scopedFlights.get(scope) : flights
  if (!pending) { pending = new Map(); scopedFlights.set(scope!, pending) }
  const key = JSON.stringify(parts)
  const current = pending.get(key)
  if (current) { joined++; return current as Promise<T> }
  const flight = read().finally(() => { if (pending.get(key) === flight) pending.delete(key) })
  pending.set(key, flight)
  return flight
}

/** Reads served by another request's flight on this instance (tests and diagnostics). */
export function singleFlightJoined() { return joined }

/** Tests only: measure the same reads without sharing. */
export function measureWithoutSingleFlight(value: boolean) { measuringWithout = value }
