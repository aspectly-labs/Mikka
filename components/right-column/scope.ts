'use client'

import { createContext, useContext } from 'react'
import type { ThreadPanelTabId } from '@/components/slots/thread-contract'

/**
 * What a conversation's right column is about (#2927): a thread (its run chain, and its task when it has one), or a
 * Bot's chat (no machine of its own; the Coordinator's chat is a Bot's chat with `coordinator`).
 */
export type RightColumnScope =
  | { kind: 'thread'; runId: string; issueId: string | null }
  | { kind: 'bot'; botId: string | null; coordinator: boolean; environmentId: string | null }

/** Lets a tab bring another tab of the same column to the front (Files' 「View thread diff」 shows Changes). */
export const RightColumnNavigation = createContext<{ show: (id: ThreadPanelTabId) => void } | null>(null)
export const useRightColumnNavigation = () => useContext(RightColumnNavigation)
