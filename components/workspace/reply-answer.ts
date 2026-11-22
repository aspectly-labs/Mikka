import { createContext } from 'react'

/**
 * What the person said right after this reply, when the host knows it: a
 * choice card shows that answer picked after a reload (Figma 379:5694).
 * Its own module so a chat can provide it without loading the cards (OpenUI).
 */
export const ReplyAnswer = createContext<string | null>(null)
