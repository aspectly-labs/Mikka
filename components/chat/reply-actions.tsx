'use client'

import type { ReactNode } from 'react'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Quote } from '@/components/icons'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { CopyAction, HOVER_ACTIONS, REPLY_ACTIONS } from '@/components/chat/copy-action'
import { quotable } from '@/lib/chat-quote'
import { cn } from '@/lib/utils'

/**
 * The line under a message (#2922, Figma `1318:59`): when it was sent, Reply, Copy, then what the caller adds (the pages
 * a reply cites, reactions). Reply quotes the whole message into the composer, the same quote 引用 makes from selected
 * words, cut to the same length (lib/chat-quote.ts REPLY_QUOTE_MAX) so a long reply cannot push a message over the send
 * limit. It stays on screen, quiet until hovered (R-83 revised 2026-11-10); the thread panel keeps it to hover
 * (decision 2026-11-10-2002 A). The More menu waits for its first action that is not already on this line (fork, side chat and rerun
 * need #2936).
 */
export function ReplyActions({ at, copyText, quoteText, onQuote, hover = false, children }: {
  /** When the message was sent, as a timestamp in ms. */
  at?: number
  copyText: string
  /** What Reply quotes when it differs from what Copy copies (a thread message made of several replies). */
  quoteText?: string
  /** Puts the message in the composer as a quote; without it there is no Reply. */
  onQuote?: (text: string) => void
  /** Shown while the message is hovered or focused, always on touch: the thread panel's messages (decision 2026-11-10-2002 A). */
  hover?: boolean
  children?: ReactNode
}) {
  const t = useTranslations('AiElements.message')
  const format = useFormatter()
  return <MessageActions className={cn('items-center', hover ? HOVER_ACTIONS : REPLY_ACTIONS)} data-slot="reply-actions">
    {at !== undefined && Number.isFinite(at) && at > 0 && <time dateTime={new Date(at).toISOString()} className="px-1 text-xs tabular-nums text-muted-foreground"
      title={format.dateTime(new Date(at), { dateStyle: 'full', timeStyle: 'short' })}>
      {format.dateTime(new Date(at), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
    </time>}
    {onQuote && <MessageAction tooltip={t('reply')} onClick={() => onQuote(quotable(quoteText ?? copyText))}><Quote aria-hidden="true" /></MessageAction>}
    <CopyAction text={copyText} />
    {children}
  </MessageActions>
}
