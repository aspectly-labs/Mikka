'use client'

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@/lib/hooks/use-reduced-motion'

/**
 * The pace of a streaming reply, from LobeHub's `balanced` preset (@lobehub/streamdown 1.4.0,
 * `useSmoothStreamContent`): characters per second follow how fast text arrives, held a short buffer behind it while
 * it keeps arriving, and drained faster once it pauses. Mikka differs on purpose: the end of the stream and a large
 * backlog show everything at once instead of animating on.
 */
export const SMOOTH_TEXT = {
  /** Arrival rate before any is measured, and its clamp. */
  defaultCps: 38, minCps: 18, maxCps: 72,
  /** While text keeps arriving: the highest pace, and how far behind it stays (ms of text at the measured pace). */
  maxActiveCps: 132, targetBufferMs: 120,
  /** Once nothing has arrived for `activeInputWindowMs`: drain the rest at this pace. */
  activeInputWindowMs: 220, flushCps: 120, maxFlushCps: 280,
  /** Smoothing of the measured arrival rate. */
  emaAlpha: 0.2,
  /** A redraw at most this often: each one parses the reply again. */
  minCommitIntervalMs: 48,
  /** A chunk larger than this, or a backlog larger than `maxLagChars`, shows at once (LobeHub: `largeAppendChars`). */
  largeAppendChars: 120, maxLagChars: 240,
} as const

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/** Never end a shown prefix inside a surrogate pair. */
const boundary = (text: string, at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) ? at + 1 : at

/**
 * A live reply's text, revealed a few characters at a time at the pace it arrives (LobeHub's streaming), as a prefix of
 * `text`: nothing is dropped or reordered. Stored text (`live` false), reduced motion, a large chunk, a far backlog,
 * text that is not a continuation of what came before and the end of the stream all show the whole text at once.
 * One animation frame loop per live reply, running only while shown text is behind; it reads nothing from the server.
 */
export function useSmoothText(text: string, live: boolean): string {
  const reduced = useReducedMotion()
  const smooth = live && !reduced
  const [shown, setShown] = useState(text)
  const ref = useRef({ target: text, shown: text, frame: 0, lastFrame: 0, lastInput: 0, cps: SMOOTH_TEXT.defaultCps as number })

  useEffect(() => {
    const state = ref.current
    const stop = () => { if (state.frame) cancelAnimationFrame(state.frame); state.frame = 0; state.lastFrame = 0 }
    const show = (value: string) => { stop(); state.target = value; state.shown = value; state.cps = SMOOTH_TEXT.defaultCps; setShown(value) }
    // Unchanged and already drawing (or caught up): nothing to do. A loop a remount stopped starts again below.
    if (text === state.target && smooth && (state.frame || state.shown === state.target)) return
    const added = text.length - state.target.length
    if (!smooth || !text.startsWith(state.target) || added > SMOOTH_TEXT.largeAppendChars || text.length - state.shown.length > SMOOTH_TEXT.maxLagChars) {
      show(text)
      state.lastInput = performance.now()
      return
    }
    const now = performance.now()
    if (state.lastInput && added > 0) {
      const arrived = clamp(added * 1000 / Math.max(1, now - state.lastInput), SMOOTH_TEXT.minCps, SMOOTH_TEXT.maxActiveCps)
      state.cps = state.cps * (1 - SMOOTH_TEXT.emaAlpha) + arrived * SMOOTH_TEXT.emaAlpha
    }
    if (added > 0) state.lastInput = now
    state.target = text
    if (state.frame) return
    const tick = (at: number) => {
      const backlog = state.target.length - state.shown.length
      if (backlog <= 0) { stop(); return }
      if (!state.lastFrame || at - state.lastFrame < SMOOTH_TEXT.minCommitIntervalMs) {
        if (!state.lastFrame) state.lastFrame = at
        state.frame = requestAnimationFrame(tick)
        return
      }
      const seconds = Math.min(0.12, (at - state.lastFrame) / 1000)
      state.lastFrame = at
      const arriving = performance.now() - state.lastInput <= SMOOTH_TEXT.activeInputWindowMs
      const base = clamp(state.cps, SMOOTH_TEXT.minCps, SMOOTH_TEXT.maxCps)
      // Arriving: stay a short buffer behind, faster the further behind it is. Paused: drain what is left.
      const lag = arriving ? Math.max(1, Math.round(base * SMOOTH_TEXT.targetBufferMs / 1000)) : 0
      const cps = arriving ? clamp(base * clamp(backlog / lag, 1, 4.5), SMOOTH_TEXT.minCps, SMOOTH_TEXT.maxActiveCps)
        : clamp(Math.max(SMOOTH_TEXT.flushCps, base * 1.8), SMOOTH_TEXT.flushCps, SMOOTH_TEXT.maxFlushCps)
      const room = backlog - lag
      if (room > 0) {
        const next = boundary(state.target, state.shown.length + Math.min(room, Math.max(1, Math.round(cps * seconds))))
        state.shown = state.target.slice(0, next)
        setShown(state.shown)
      }
      state.frame = requestAnimationFrame(tick)
    }
    state.frame = requestAnimationFrame(tick)
  }, [text, smooth])

  useEffect(() => () => {
    const state = ref.current
    if (state.frame) cancelAnimationFrame(state.frame)
    state.frame = 0
    state.lastFrame = 0
  }, [])

  return smooth ? shown : text
}
