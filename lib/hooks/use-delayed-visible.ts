'use client'

import { useEffect, useLayoutEffect, useState } from 'react'

/**
 * Below this, a placeholder is on screen for less time than it takes to read as one: it registers as a flicker
 * between two layouts rather than as loading (UX audit 2026-11-22 #3; LobeHub `components/Skeleton/Delayed.tsx`).
 */
export const SKELETON_DELAY_MS = 200

/**
 * A placeholder that follows one already on screen paints at once: the chat's loading passes through several
 * owners (the app's first paint, the page's chunk, the chat's first read), each with its own copy of the same
 * skeleton, and waiting again at every hand-over would blank the pane the person is already reading a skeleton in.
 */
export const SKELETON_HANDOVER_MS = 400

let lastVisibleAt = -Infinity
let visible = 0
// A chain of placeholders still inside their delay shares one: a hand-over does not start the wait again.
let waitingSince = -Infinity
let lastWaitingAt = -Infinity
let waiting = 0
/** A waiting placeholder hands over in the same commit; any longer and content stood between them. */
const WAIT_HANDOVER_MS = 50

/** True while a skeleton is on screen or was a moment ago. The next one renders before the last one's cleanup runs. */
export function isSkeletonHandover(now = performance.now()) {
  return visible > 0 || now - lastVisibleAt < SKELETON_HANDOVER_MS
}

/**
 * `html[data-chat-skeleton]` marks the hand-over window for a skeleton drawn in CSS: the official thread screen paints
 * its own before the first read (hosted styles/globals.css), and shows it at once while this attribute is set.
 */
const HANDOVER_ATTRIBUTE = 'data-chat-skeleton'
/** Longer than the in-app hand-over: the screen that takes over may first be styled a busy moment later. */
const CSS_HANDOVER_MS = 1_000
let clearHandover: ReturnType<typeof setTimeout> | undefined

/** Count a skeleton as on screen until the returned cleanup runs. */
function retainSkeleton() {
  visible += 1
  lastVisibleAt = performance.now()
  clearTimeout(clearHandover)
  document.documentElement.setAttribute(HANDOVER_ATTRIBUTE, '')
  return () => {
    visible -= 1
    lastVisibleAt = performance.now()
    clearTimeout(clearHandover)
    clearHandover = setTimeout(() => { if (visible === 0) document.documentElement.removeAttribute(HANDOVER_ATTRIBUTE) }, CSS_HANDOVER_MS)
  }
}

/** When the wait of a placeholder mounting now started: the chain's start when it takes over a waiting one. */
function waitStart(now: number) {
  if (waiting === 0 && now - lastWaitingAt >= WAIT_HANDOVER_MS) waitingSince = now
  return waitingSince
}

/** Whether a skeleton should show yet: after `delay`, or at once when it takes over from another one. */
export function useDelayedVisible(delay = SKELETON_DELAY_MS) {
  const [elapsed, setElapsed] = useState(() => typeof performance !== 'undefined' && isSkeletonHandover())
  const [since] = useState(() => typeof performance === 'undefined' ? 0 : waitStart(performance.now()))
  useEffect(() => {
    if (elapsed) return
    waiting += 1
    const timer = setTimeout(() => setElapsed(true), Math.max(0, delay - (performance.now() - since)))
    return () => { clearTimeout(timer); waiting -= 1; lastWaitingAt = performance.now() }
  }, [delay, elapsed, since])
  // A layout effect, so it is counted before the commit that replaces it runs the next skeleton's first render.
  useLayoutEffect(() => elapsed ? retainSkeleton() : undefined, [elapsed])
  return elapsed
}
