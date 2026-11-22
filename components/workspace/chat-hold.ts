'use client'

import { useEffect, useRef, useState } from 'react'

/** The longest the previous chat stays while the next one reads; then the next one opens on its own skeleton. */
export const CHAT_HOLD_MS = 1_500

/**
 * The chat to draw in the centre while the person switches to another one (UX audit 2026-11-22 #3, #4). The
 * chat that was on screen stays until the next one's first read has landed in the cache, so the switch goes
 * from one transcript to the other with no blank pane and no skeleton between them. A chat already read
 * (cached, or prefetched when its row was pointed at) opens at once; nothing is held on the first open, or when
 * the centre was showing something else (`active` false), since there is no chat to keep then.
 *
 * `key` names a chat; `ready` says whether its first read is in hand; `load` starts that read (the same
 * read the chat makes, so it is not made twice) and settles when it has, failed or not.
 */
export function useChatHold<T>(next: T, { active, key, ready, load, holdMs = CHAT_HOLD_MS }: {
  active: boolean
  key: (chat: T) => string
  ready: (chat: T) => boolean
  load: (chat: T) => Promise<unknown>
  holdMs?: number
}): T {
  const [shown, setShown] = useState<{ chat: T; active: boolean }>({ chat: next, active })
  const wanted = key(next)
  const holding = active && shown.active && key(shown.chat) !== wanted && !ready(next)
  // Settle the shown chat during render, so a chat that needs no hold is never drawn a frame late.
  if (!holding && (shown.chat !== next || shown.active !== active)) setShown({ chat: next, active })
  const latest = useRef(next)
  latest.current = next
  useEffect(() => {
    if (!holding) return
    let done = false
    const open = () => {
      if (done || key(latest.current) !== wanted) return
      done = true
      setShown({ chat: latest.current, active: true })
    }
    void load(latest.current).then(open, open)
    const timer = setTimeout(open, holdMs)
    return () => { done = true; clearTimeout(timer) }
    // Only a different chat to wait for restarts the wait; `key`, `ready` and `load` are read when it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding, wanted, holdMs])
  return holding ? shown.chat : next
}
