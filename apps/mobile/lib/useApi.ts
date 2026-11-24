import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { api, ApiError, onWorkspaceChange } from '@/lib/api'
import { apiCache as cache } from './api-cache'
import { needsForegroundRead, withholdsCachedRead } from './api-read-state'
import { live, useLive, type LiveSpec } from './live'
import { presenceScope } from './presence-scope'
import { isTransientReadFailure, readFailureOutcome, readWithRetry, type ReadMode } from './read-retry'

/** Subscribe to the native foreground transition. Callers decide whether
 * an already-loaded result needs a receipt or a stale result needs a read. */
export function onAppForeground(entered: () => void) {
  const subscription = AppState.addEventListener('change', state => { if (state === 'active') entered() })
  return () => subscription.remove()
}

// Counts trips to the background while any read is mounted: a read that saw
// it change was cut off by iOS, not refused by the server (lib/read-retry.ts).
let backgroundTrips = 0, trackers = 0
let backgroundSubscription: { remove: () => void } | null = null
function trackBackground() {
  if (trackers++ === 0) backgroundSubscription = AppState.addEventListener('change', state => { if (state === 'background') backgroundTrips++ })
  return () => { if (--trackers === 0) { backgroundSubscription?.remove(); backgroundSubscription = null } }
}
const inForeground = () => AppState.currentState === 'active'
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

// The last answer per path, so a screen opened again draws at once and refreshes behind (a chat is not blank while it loads).
// Another workspace's answers are dropped.
/** Data younger than this is fresh: coming back to the app leaves it alone (decision 2026-11-01-0400-no-refetch-on-focus). */
export const FRESH_FOR_MS = 60_000
onWorkspaceChange(() => cache.clear())

/** Loads `path` ahead of its screen, once, so opening it draws at once (线程 warms the top chats). */
export async function prefetch(path: string) {
  await cache.prefetch(path, api)
}

/** On signing out: nothing of this account is drawn for the next, and its live connections close. */
export const clearApiCache = () => { cache.clear(); presenceScope.clear(); live.reset() }

/**
 * Loads `path` once, and lets the screen reload or patch it after a write. It
 * starts from the path's last answer, when there is one. It never polls: data
 * that changes on its own uses useLiveApi (decision 2026-11-05-0200-no-new-polling).
 */
export function useApi<T>(path: string | null, options?: { read: (path: string) => Promise<T> }) {
  return useApiRead<T>(path, options?.read ?? api, false)
}

/**
 * Loads `path` and reads it again when the server pushes one of the keys `spec`
 * returns for the current data (lib/live.ts): no timer while connected, one read
 * a minute while disconnected, nothing in the background and one read on coming
 * back. The keys are the ones the web listens to for the same data.
 */
export function useLiveApi<T>(path: string | null, spec: (data: T | null) => LiveSpec, read: (path: string) => Promise<T> = api) {
  const state = useApiRead<T>(path, read, true)
  useLive(path ? spec(state.data) : { refs: [] }, state.refresh, state.requestedAt)
  return state
}

function useApiRead<T>(path: string | null, read: (path: string) => Promise<T>, pushed: boolean) {
  const [data, setStored] = useState<T | null>(() => path ? cache.get<T>(path) : null)
  const [source, setSource] = useState(() => ({ path, context: cache.context() }))
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const request = useRef(0)
  const context = cache.context()
  const revision = path ? cache.revision(path) : 0
  const setData = useCallback((next: T | null | ((current: T | null) => T | null)) => {
    cache.commit(context, () => {
      if (path && (cache.revision(path) !== revision || cache.denial(path))) return
      // A saved mutation is newer than a read already in flight.
      request.current++; pending.current = null; setLoading(false); setError(null); failed.current = false
      setStored(current => {
        let value = current
        cache.commit(context, () => {
          if (path && (cache.revision(path) !== revision || cache.denial(path))) return
          value = typeof next === 'function' ? (next as (current: T | null) => T | null)(current) : next
          if (path && value !== null) cache.set(path, value, context)
        })
        return value
      })
    })
  }, [path, context, revision])
  const activePath = useRef(path)
  const loadedAt = useRef(0)
  // When the last successful read started (performance clock): a pushed deadline counts from it.
  const [requestedAt, setRequestedAt] = useState<number | null>(null)
  const failed = useRef(false)
  const pending = useRef<{ context: number; path: string; ticket: number; promise: Promise<void>; mode: ReadMode } | null>(null)
  const hasData = useRef(data !== null)
  hasData.current = data !== null
  // A read the person asked for that iOS cut off: its redo keeps their mode, so its failure still shows.
  const resumeShown = useRef(false)

  /**
   * One read of `path`. A transient failure is retried with backoff first; a
   * `quiet` read (the app's own refresh) that still fails keeps the content
   * on screen, and a read iOS cut off by suspending the app is redone in the
   * foreground instead of shown as an error (lib/read-retry.ts).
   */
  const load = useCallback((mode: ReadMode = 'shown'): Promise<void> => {
    if (!path || activePath.current !== path) return Promise.resolve()
    const context = cache.context()
    if (pending.current?.context === context && pending.current.path === path) {
      // The person asked while the app was refreshing on its own: this read's failure is theirs to see.
      if (mode === 'shown' || resumeShown.current) { pending.current.mode = 'shown'; resumeShown.current = false }
      return pending.current.promise
    }
    if (resumeShown.current) { mode = 'shown'; resumeShown.current = false }
    const readRevision = cache.revision(path)
    const ticket = ++request.current
    const trips = backgroundTrips
    const current = () => activePath.current === path && ticket === request.current && cache.context() === context && cache.revision(path) === readRevision
    const accept = (apply: () => void) => cache.commit(context, () => { if (current()) apply() })
    accept(() => setLoading(true))
    const clock = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
    // A pushed deadline counts from the attempt that answered, not from the first one that failed.
    let started = clock()
    const entry = { context, path, ticket, promise: Promise.resolve(), mode }
    let again = false
    entry.promise = (async () => {
      try {
        const next = await readWithRetry(() => { started = clock(); return read(path) }, { canRetry: () => current() && inForeground() && trips === backgroundTrips, wait: pause })
        accept(() => { cache.storeRead(path, next, context); setStored(next); setError(null); failed.current = false; loadedAt.current = Date.now(); setRequestedAt(started) })
      } catch (failure) {
        accept(() => {
          if (failure instanceof ApiError && withholdsCachedRead(failure.status)) {
            cache.revoke(path, context, failure)
            return
          }
          failed.current = true
          const interrupted = trips !== backgroundTrips || !inForeground()
          const outcome = readFailureOutcome({ transient: isTransientReadFailure(failure), interrupted, mode: entry.mode, hasData: hasData.current })
          if (outcome === 'show') setError(failure as Error)
          else if (interrupted) {
            if (entry.mode === 'shown') resumeShown.current = true
            // Back in the foreground before this read gave up: its own foreground read joined it, so read once more now.
            again = inForeground()
          }
        })
      } finally {
        accept(() => setLoading(false))
        if (pending.current?.ticket === ticket) pending.current = null
      }
      if (again) await load('quiet')
    })()
    pending.current = entry
    return entry.promise
  }, [path, read])
  const reload = useCallback(() => load('shown'), [load])
  const refresh = useCallback(() => load('quiet'), [load])

  // A post-write read must start after the acknowledgement, even when a previous snapshot is in flight.
  const reloadAfterWrite = useCallback(async () => {
    if (!path) return
    const reading = pending.current
    if (reading?.path === path && reading.context === context) await reading.promise
    if (activePath.current === path && context === cache.context() && revision === cache.revision(path)) await load('shown')
  }, [context, load, path, revision])

  useEffect(() => {
    if (!path) return
    return cache.onRevoked(path, reason => {
      request.current++
      pending.current = null
      loadedAt.current = 0
      failed.current = true
      setStored(null)
      setRequestedAt(null)
      setLoading(false)
      setError(reason)
    })
  }, [path])

  useEffect(() => {
    activePath.current = path
    setSource({ path, context: cache.context() })
    setStored(path ? cache.get<T>(path) : null)
    setError(null)
    loadedAt.current = 0; failed.current = false; pending.current = null; resumeShown.current = false; setRequestedAt(null)
    setLoading(Boolean(path))
    void load()
    return () => { activePath.current = null; request.current++ }
  }, [load, path])

  useEffect(() => onWorkspaceChange(() => {
    setSource({ path, context: cache.context() })
    setStored(null); setError(null); loadedAt.current = 0; failed.current = false; pending.current = null; resumeShown.current = false; setRequestedAt(null); setLoading(Boolean(path))
    void load()
  }), [load, path])

  useEffect(() => trackBackground(), [])

  useEffect(() => {
    if (!path) return
    return onAppForeground(() => {
      // Pushed screens catch up on their live channel. Only a failed or stale
      // read needs an additional request on returning to the foreground.
      if (pushed ? failed.current || loadedAt.current === 0 : needsForegroundRead(loadedAt.current, failed.current, Date.now(), FRESH_FOR_MS)) void load('quiet')
    })
  }, [load, path, pushed])

  const sameSource = source.path === path && source.context === context
  const denial = path ? cache.denial(path) : null
  return { data: denial ? null : sameSource ? data : path ? cache.get<T>(path) : null, error: denial ?? (sameSource ? error : null), loading: sameSource ? loading : Boolean(path), reload, refresh, reloadAfterWrite, setData, requestedAt: sameSource ? requestedAt : null }
}

/** Pull to refresh for a list (the system's RefreshControl): reloads and shows the spinner until the data is back. */
export function useRefresh(reload: () => Promise<void>) {
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try { await reload() } finally { setRefreshing(false) }
  }, [reload])
  return { refreshing, onRefresh }
}
