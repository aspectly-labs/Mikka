'use client'

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { TranscriptPin } from './thread-contract'

/** How long the glide up to a sent message takes, and how long a send may take to be listed (as the Bot chat's). */
const SEND_PIN_GLIDE_MS = 800
const SEND_PIN_WAIT_MS = 10_000
/** A scroll this soon after the person's own wheel, touch or key is theirs: it lets the pin go. */
const INTENT_MS = 700
/** The pinned message stands this far below the top of the view, the column's gap. */
const SEND_PIN_GAP = 16

/**
 * The blank space under the column that lets the view's top stand at `top` (LobeHub's calculateConversationSpacerHeight,
 * the Bot chat's `sendPinSpace`): the view's height less what stands from there to the column's `end`, never below none.
 */
export const sendPinSpace = ({ view, top, end }: { view: number; top: number; end: number }) => Math.max(0, Math.round(view - (end - top)))

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The group chat's scroller (the Bot chat's send-pinning, decision 2026-11-22-1500-group-chat-as-bot-chat): it follows the
 * newest message while `following`; after the person's own send their message glides to the top of the view, a spacer
 * under the column holding it there, and the replies write below it in the space left. The spacer shrinks as they grow;
 * once they fill the view it is gone and the chat follows the newest as before. Scrolling up lets go.
 */
export function useTranscriptScroll({ scroller, column, spacer, end, following, pin }: {
  scroller: RefObject<HTMLDivElement | null>
  column: RefObject<HTMLElement | null>
  spacer: RefObject<HTMLDivElement | null>
  /** Changes whenever the newest message or the waiting rows change. */
  end?: string
  following?: boolean
  pin?: TranscriptPin
}) {
  const space = useRef(0)
  const held = useRef<{ holding: boolean; glideUntil: number; to: number } | null>(null)
  const seen = useRef(pin?.sends ?? 0)
  const armed = useRef<number | null>(null)
  const latest = useRef(pin)
  const intentAt = useRef(0)
  const glideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useLayoutEffect(() => { latest.current = pin })

  const setSpace = (height: number) => {
    space.current = height
    if (spacer.current) spacer.current.style.height = height > 0 ? `${height}px` : ''
    if (height <= 0) held.current = null
  }
  const targetNode = () => {
    const id = latest.current?.target
    if (!id || !column.current) return null
    return [...column.current.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === id) ?? null
  }
  const needed = () => {
    const el = scroller.current, col = column.current, node = targetNode()
    if (!el || !col || !node) return 0
    const box = el.getBoundingClientRect()
    const top = node.getBoundingClientRect().top - box.top + el.scrollTop
    const bottom = col.getBoundingClientRect().bottom - box.top + el.scrollTop
    return sendPinSpace({ view: el.clientHeight, top: top - SEND_PIN_GAP, end: bottom })
  }
  const hold = () => {
    const current = held.current, el = scroller.current
    if (!current || !el) return
    const next = needed()
    setSpace(current.holding ? next : Math.min(space.current, next))
    if (!held.current?.holding) return
    const bottom = el.scrollHeight - el.clientHeight
    if (current.glideUntil > Date.now()) {
      if (Math.abs(current.to - bottom) > 1) el.scrollTo({ top: (current.to = bottom), behavior: 'smooth' })
    } else el.scrollTop = el.scrollHeight
  }
  const holdRef = useRef(hold)
  useLayoutEffect(() => { holdRef.current = hold })
  const start = () => {
    const el = scroller.current
    if (!el) return
    const smooth = !reducedMotion()
    const current = { holding: true, glideUntil: smooth ? Date.now() + SEND_PIN_GLIDE_MS : 0, to: -1 }
    held.current = current
    // A message taller than the view needs no space: the chat follows the replies as before.
    setSpace(needed())
    if (!smooth || held.current !== current) { el.scrollTop = el.scrollHeight; return }
    current.to = el.scrollHeight - el.clientHeight
    el.scrollTo({ top: current.to, behavior: 'smooth' })
    clearTimeout(glideTimer.current)
    glideTimer.current = setTimeout(() => {
      if (held.current !== current || !current.holding || !current.glideUntil) return
      current.glideUntil = 0
      el.scrollTop = el.scrollHeight
    }, SEND_PIN_GLIDE_MS)
  }

  // The newest message, a send or a reply starting keeps a following chat at its end; a glide is not cut short.
  // While a send is pinned, a new reply shrinks the space under it instead.
  useLayoutEffect(() => {
    const el = scroller.current
    if (held.current) { holdRef.current(); return }
    if (following && el) el.scrollTop = el.scrollHeight
  }, [end, following, scroller])

  // Arm on the person's own send; pin once their message is listed, within the wait.
  useLayoutEffect(() => {
    if (pin && pin.sends !== seen.current) {
      seen.current = pin.sends
      armed.current = Date.now() + SEND_PIN_WAIT_MS
    }
    if (armed.current !== null && targetNode()) {
      const inTime = Date.now() <= armed.current
      armed.current = null
      if (inTime) start()
      return
    }
    // The pinned row was listed again under its stored id: the space follows it.
    holdRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.sends, pin?.target])

  useEffect(() => {
    const el = scroller.current, col = column.current
    if (!el || !col) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => holdRef.current())
    observer?.observe(col)
    observer?.observe(el)
    const intent = () => { intentAt.current = Date.now() }
    let previous = el.scrollTop
    const onScroll = () => {
      const top = el.scrollTop
      const up = previous - top
      previous = top
      const current = held.current
      if (!current || up <= 0 || Date.now() - intentAt.current >= INTENT_MS) return
      current.holding = false
      current.glideUntil = 0
      if (!latest.current?.busy) setSpace(Math.max(0, space.current - up))
    }
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) el.addEventListener(type, intent, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer?.disconnect()
      for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) el.removeEventListener(type, intent)
      el.removeEventListener('scroll', onScroll)
      clearTimeout(glideTimer.current)
      held.current = null
    }
  }, [scroller, column])
}
