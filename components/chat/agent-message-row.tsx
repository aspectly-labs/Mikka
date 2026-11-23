'use client'

import type { ReactNode } from 'react'
import { ChevronRight } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/lib/intl/i18n-client'

/**
 * A message one agent sent another, as Claude Code's desktop app shows a message to or from a sub-agent (Alex,
 * 2026-11-23): one collapsed row in the tool rows' look (the hosted Thread's `ui-th-tool` classes: 13px, muted, no icon
 * or status glyph), 「Coordinator 派发了任务 · CHAT-1 校验聊天结构 ›」 or 「收到 Codex 的回复 · …」. Opening it shows the
 * whole message in the one panel an opened tool shows, with a way to where it came from. It is never another speaker
 * in a single chat: no author header and no bubble.
 */
export function AgentMessageRow({ title, subject, children, open }: {
  /** What happened, with who: 「Coordinator 派发了任务」. */
  title: string
  /** What it is about, after a dot: the task's code and title. */
  subject?: string | null
  /** The whole message, shown once the row is opened. */
  children: ReactNode
  /** Where it came from: the sender's chat or the thread, opened from inside the panel. */
  open?: { label: string; onOpen: () => void }
}) {
  const label = subject ? `${title} · ${subject}` : title
  return (
    <Collapsible data-agent-message-row="" className="ui-th-tool-details min-w-0">
      <CollapsibleTrigger className="ui-th-tool w-full cursor-pointer rounded-md text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" data-kind="message" data-status="done">
        <span className="ui-th-tool__label" dir="auto" title={label}>{label}</span>
        <span className="ui-th-tool__chev transition-transform in-data-panel-open:rotate-90 motion-reduce:transition-none" aria-hidden="true"><ChevronRight className="size-3" /></span>
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="ui-th-tool-details__body">
        <div data-agent-message-body="" className="flex max-h-96 min-w-0 flex-col gap-2 overflow-auto overscroll-contain rounded-lg border border-border bg-card px-2.5 py-2 text-start scrollbar-thin">
          <div className="min-w-0 wrap-anywhere">{children}</div>
          {open && <Button variant="link" size="xs" className="self-start px-0" onClick={open.onOpen}>{open.label}</Button>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The words of an agent message row, in the person's language. */
export function useAgentMessageWords() {
  const t = useTranslations('AgentMessageRow')
  return {
    dispatched: (name: string) => t('dispatched', { name }),
    sent: (name: string) => t('sent', { name }),
    reply: (name: string) => t('reply', { name }),
    message: (name: string) => t('message', { name }),
    question: (name: string) => t('question', { name }),
    openChat: (name: string) => t('openChat', { name }),
    openThread: t('openThread'),
  }
}
