'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { CLEAR_VIEW_STATE_EVENT, VIEW_STATE_PREFIX } from '../chat-drafts'

/**
 * A chat's unsent draft and the person's earlier prompts outlive the window (closing it must not lose what was being
 * written), so they go to localStorage; other browsing state stays with this window's session. Both are cleared on
 * logout (lib/chat-drafts.ts).
 */
const durable = (key: string) => key.endsWith(':draft') || key.endsWith(':history')
/** The most one durable cell may take (in UTF-16 units of its JSON), so drafts cannot fill the origin's quota. */
export const DURABLE_MAX = 64 * 1024

/** Browsing state lives for this window's session, separate from saved product settings. */
export function createViewStore(scope: string | null) {
  const values = new Map<string, unknown>()
  // One listener set per cell: a list saves its scroll position on every scroll event, and that
  // write must not wake every other reader on the screen (they read a different key).
  const cellListeners = new Map<string, Set<() => void>>()
  // The escape hatch for a reader that cannot name one cell: it hears every write.
  const anyListeners = new Set<() => void>()
  const generations = new Map<string, number>()
  let active = true
  const storageKey = (key: string) => `${VIEW_STATE_PREFIX}v1:${scope}:${key}`
  return {
    activate() { active = true },
    retire() { active = false },
    get<T,>(key: string, fallback: T): T {
      if (!values.has(key) && scope && typeof window !== 'undefined') {
        try {
          // A draft saved before drafts moved to localStorage is still in this window's session.
          const saved = (durable(key) ? window.localStorage.getItem(storageKey(key)) : null) ?? window.sessionStorage.getItem(storageKey(key))
          if (saved !== null) values.set(key, JSON.parse(saved))
        } catch { /* The in-memory store still works when storage is unavailable. */ }
      }
      return values.has(key) ? values.get(key) as T : fallback
    },
    generation(key: string) { return generations.get(key) ?? 0 },
    reset<T,>(key: string, value: T) {
      generations.set(key, this.generation(key) + 1)
      this.set(key, value)
    },
    set<T,>(key: string, value: T, generation?: number) {
      if (!active || (generation !== undefined && generation !== this.generation(key))) return
      values.set(key, value)
      if (scope) {
        try {
          const saved = JSON.stringify(value)
          if (!durable(key)) window.sessionStorage.setItem(storageKey(key), saved)
          else {
            window.sessionStorage.removeItem(storageKey(key))
            // An empty draft (sent, cleared) leaves nothing behind; one past the cap lives only in this window.
            if (value === '' || (Array.isArray(value) && !value.length)) window.localStorage.removeItem(storageKey(key))
            else if (saved.length > DURABLE_MAX) { window.localStorage.removeItem(storageKey(key)); window.sessionStorage.setItem(storageKey(key), saved) }
            else window.localStorage.setItem(storageKey(key), saved)
          }
        } catch { /* storage unavailable or full */ }
      }
      // Copy out first: a listener may unsubscribe another while it runs, and
      // iterating the live Set would then skip whichever one sat after it.
      const forKey = cellListeners.get(key)
      if (forKey) for (const listener of Array.from(forKey)) listener()
      if (anyListeners.size) for (const listener of Array.from(anyListeners)) listener()
    },
    /** Subscribe to one cell. Every `useViewState` reader takes this path. */
    subscribeKey(key: string, listener: () => void) {
      const forKey = cellListeners.get(key) ?? new Set<() => void>()
      if (!cellListeners.has(key)) cellListeners.set(key, forKey)
      forKey.add(listener)
      return () => { forKey.delete(listener); if (!forKey.size && cellListeners.get(key) === forKey) cellListeners.delete(key) }
    },
    /** Hears every cell. A reader that knows its key must use `subscribeKey` (or it re-renders on unrelated writes). */
    subscribe(listener: () => void) { anyListeners.add(listener); return () => { anyListeners.delete(listener) } },
  }
}

const ViewStateContext = createContext<ReturnType<typeof createViewStore> | null>(null)

export function ViewStateProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const store = useMemo(() => createViewStore(scope), [scope])
  // Page navigation may finish a pending draft update, but a discarded account
  // or workspace must never repopulate storage after its security boundary clears it.
  useLayoutEffect(() => {
    store.activate()
    window.addEventListener(CLEAR_VIEW_STATE_EVENT, store.retire)
    return () => { window.removeEventListener(CLEAR_VIEW_STATE_EVENT, store.retire); store.retire() }
  }, [store])
  return <ViewStateContext.Provider value={store}>{children}</ViewStateContext.Provider>
}

function useViewStore() {
  const provided = useContext(ViewStateContext)
  const local = useMemo(() => createViewStore(null), [])
  return provided ?? local
}

/** A confirmed loss of group membership also retires this tab's saved drafts. */
export function useForgetGroupDrafts(ownerId: string, workspaceId: string | null) {
  const store = useViewStore()
  return useCallback((id: string) => {
    if (!workspaceId) return
    store.reset(`group:${id}:draft`, '')
    store.reset(`group:${id}:pending`, [])
    store.reset(`chat-send:group:${ownerId}:${workspaceId}:${id}`, [])
  }, [store, ownerId, workspaceId])
}

/** A keyed state cell: changing objects reads that object's state immediately. */
export function useViewState<T,>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const store = useViewStore()
  const initialRef = useRef({ store, key, value: initial })
  if (initialRef.current.store !== store || initialRef.current.key !== key) initialRef.current = { store, key, value: initial }
  const fallback = initialRef.current.value
  const getSnapshot = useCallback(() => store.get(key, fallback), [store, key, fallback])
  // Stable per key, or `useSyncExternalStore` would resubscribe on every render.
  const subscribe = useCallback((listener: () => void) => store.subscribeKey(key, listener), [store, key])
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback)
  // A late completion belongs to the membership under which this cell was opened.
  const generation = useMemo(() => store.generation(key), [store, key])
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    store.set(key, typeof next === 'function' ? (next as (previous: T) => T)(store.get(key, fallback)) : next, generation)
  }, [store, key, fallback, generation])
  return [value, setValue]
}

type Position = { top: number; left: number; end?: boolean }

/** How near the end a list counts as read to its end, as the thread's following does (agent-thread.tsx). */
const AT_END_PX = 40

/**
 * Restores after asynchronous rows/expanded groups arrive, without fighting user scrolling.
 * `anchor: 'end'` is a chat's: left at its end (or never left), it is not restored, so its owner keeps it at the
 * latest message, new ones included; scrolled up, it comes back where it was.
 */
export function useViewScroll<T extends HTMLElement>(key: string, ready = true, restoreSaved = true, anchor: 'start' | 'end' = 'start') {
  const store = useViewStore()
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !ready) return
    const cell = `scroll:${key}`
    const stored = restoreSaved ? store.get<Position | null>(cell, null) : null
    const saved = anchor === 'end' && stored?.end ? null : stored
    if (!saved && restoreSaved && anchor === 'start') { node.scrollTop = 0; node.scrollLeft = 0 }
    let restoring = !!saved
    // While a saved place is put back the node says so: a list that follows its end (the official thread) lets this
    // scroll stop the following, and keeps any other scroll nobody asked for from doing so.
    // The mark outlasts the restore by a moment, as the scroll it caused arrives a frame later.
    let unmark: ReturnType<typeof setTimeout> | undefined
    const mark = () => {
      clearTimeout(unmark)
      if (restoring) node.setAttribute('data-view-restoring', '')
      else if (node.hasAttribute('data-view-restoring')) unmark = setTimeout(() => node.removeAttribute('data-view-restoring'), 200)
    }
    const restore = () => {
      if (!restoring || !saved) return
      node.scrollTop = saved.top
      node.scrollLeft = saved.left
      if (Math.abs(node.scrollTop - saved.top) < 1 && Math.abs(node.scrollLeft - saved.left) < 1) restoring = false
      mark()
    }
    const save = () => {
      if (!restoring) store.set(cell, { top: node.scrollTop, left: node.scrollLeft,
        ...(anchor === 'end' ? { end: node.scrollHeight - node.scrollTop - node.clientHeight < AT_END_PX } : {}) })
    }
    const interact = () => { restoring = false; mark() }
    restore()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    const observe = () => { resize?.observe(node); for (const child of node.children) resize?.observe(child) }
    observe()
    const mutation = new MutationObserver(() => { observe(); restore() })
    mutation.observe(node, { childList: true, subtree: true })
    node.addEventListener('scroll', save, { passive: true })
    node.addEventListener('wheel', interact, { passive: true })
    node.addEventListener('touchstart', interact, { passive: true })
    node.addEventListener('pointerdown', interact, { passive: true })
    node.addEventListener('keydown', interact)
    window.addEventListener('pagehide', save)
    return () => {
      save()
      clearTimeout(unmark); node.removeAttribute('data-view-restoring')
      resize?.disconnect(); mutation.disconnect()
      node.removeEventListener('scroll', save)
      node.removeEventListener('wheel', interact)
      node.removeEventListener('touchstart', interact)
      node.removeEventListener('pointerdown', interact)
      node.removeEventListener('keydown', interact)
      window.removeEventListener('pagehide', save)
    }
  }, [store, key, ready, restoreSaved, anchor])
  return ref
}
