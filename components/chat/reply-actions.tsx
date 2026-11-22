'use client'

import { useState, type ReactNode } from 'react'
import { useFormatter, useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { chatStampText } from '@/lib/chat-time-stamps'
import { PencilLine, Quote, RefreshCw } from '@/components/icons'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { CopyAction, HOVER_ACTIONS } from '@/components/chat/copy-action'
import { quotable } from '@/lib/chat-quote'
import { cn } from '@/lib/utils'

/**
 * The line under a message (#2922, Figma `1318:59`): when it was sent, Reply, Copy, then what the caller adds (the pages
 * a reply cites, reactions). Reply quotes the whole message into the composer, the same quote 引用 makes from selected
 * words, cut to the same length (lib/chat-quote.ts REPLY_QUOTE_MAX) so a long reply cannot push a message over the send
 * limit. Every message's line waits for hover or focus and keeps its space (`HOVER_ACTIONS`, decision 2026-11-22-1500),
 * always shown on a touch screen. Edit (the person's message) and Regenerate (a reply) sit beside Copy as icons, as
 * under a Claude or ChatGPT message, with ‹ 1/2 › before them when the turn has earlier versions (decision
 * 2026-11-22-1700). There is still no More menu: a thread's fork and other lifecycle actions live in its ⋯ menu.
 */
export function ReplyActions({ at, copyText, quoteText, onQuote, onEdit, onRegenerate, versions, children }: {
  /** When the message was sent, as a timestamp in ms. */
  at?: number
  copyText: string
  /** What Reply quotes when it differs from what Copy copies (a thread message made of several replies). */
  quoteText?: string
  /** Puts the message in the composer as a quote; without it there is no Reply. */
  onQuote?: (text: string) => void
  /** Opens the person's message for editing; only where an edit can honestly rewrite the turn. */
  onEdit?: () => void
  /** Asks for the reply again; only where the turn can honestly run again. */
  onRegenerate?: () => void
  /** The turn's version pager (‹ 1/2 ›), when it has earlier versions. */
  versions?: ReactNode
  children?: ReactNode
}) {
  const t = useTranslations('AiElements.message')
  const format = useFormatter()
  const words = useTranslations('ChatTime')
  const locale = useLocale()
  // As the centred stamp (message-time-stamp.tsx): 「今天 15:40」, 「昨天 9:05」, the weekday within six days, then the date.
  const [now] = useState(() => Date.now())
  return <MessageActions className={cn('items-center', HOVER_ACTIONS)}>
    {at !== undefined && Number.isFinite(at) && at > 0 && <time dateTime={new Date(at).toISOString()} className="px-1 text-xs tabular-nums text-muted-foreground"
      title={format.dateTime(new Date(at), { dateStyle: 'full', timeStyle: 'short' })}>
      {chatStampText(at, now, locale, { today: time => words('today', { time }), yesterday: time => words('yesterday', { time }) })}
    </time>}
    {versions}
    {onQuote && <MessageAction tooltip={t('reply')} onClick={() => onQuote(quotable(quoteText ?? copyText))}><Quote aria-hidden="true" /></MessageAction>}
    <CopyAction text={copyText} />
    {onEdit && <MessageAction tooltip={t('edit')} onClick={onEdit}><PencilLine aria-hidden="true" /></MessageAction>}
    {onRegenerate && <MessageAction tooltip={t('regenerate')} onClick={onRegenerate}><RefreshCw aria-hidden="true" /></MessageAction>}
    {children}
  </MessageActions>
}
