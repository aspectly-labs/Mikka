'use client'

import { useState, type ReactNode } from 'react'
import { useFormatter, useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { chatStampText } from '@/lib/chat-time-stamps'
import { Quote } from '@/components/icons'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { CopyAction, HOVER_ACTIONS } from '@/components/chat/copy-action'
import { quotable } from '@/lib/chat-quote'
import { cn } from '@/lib/utils'

/**
 * The bar under a message (#2922, Figma `1318:59`): when it was sent, Reply, Copy, then what the caller adds (the pages
 * a reply cites, reactions, Edit and Regenerate where a thread has them). Reply quotes the whole message into the
 * composer, the same quote 引用 makes from selected words, cut to the same length (lib/chat-quote.ts REPLY_QUOTE_MAX) so
 * a long reply cannot push a message over the send limit. Every message's bar waits for hover or focus and keeps its
 * space (`HOVER_ACTIONS`); in the hosted thread it is LobeHub's pill, 8px under the message, on the left under a reply
 * and on the right under the person's bubble (decision 2026-11-22-2000). The time is only here: the chat draws none
 * beside a name or over the messages. No More menu (Alex, 2026-11-22): a thread's fork and other lifecycle actions live
 * in its ⋯ menu.
 */
export function ReplyActions({ at, copyText, quoteText, onQuote, children }: {
  /** When the message was sent, as a timestamp in ms. */
  at?: number
  copyText: string
  /** What Reply quotes when it differs from what Copy copies (a thread message made of several replies). */
  quoteText?: string
  /** Puts the message in the composer as a quote; without it there is no Reply. */
  onQuote?: (text: string) => void
  children?: ReactNode
}) {
  const t = useTranslations('AiElements.message')
  const format = useFormatter()
  const words = useTranslations('ChatTime')
  const locale = useLocale()
  // 「今天 15:40」, 「昨天 9:05」, the weekday within six days, then the date (lib/chat-time-stamps.ts).
  const [now] = useState(() => Date.now())
  return <MessageActions className={cn('items-center', HOVER_ACTIONS)}>
    {at !== undefined && Number.isFinite(at) && at > 0 && <time dateTime={new Date(at).toISOString()} className="px-1 text-xs tabular-nums text-muted-foreground"
      title={format.dateTime(new Date(at), { dateStyle: 'full', timeStyle: 'short' })}>
      {chatStampText(at, now, locale, { today: time => words('today', { time }), yesterday: time => words('yesterday', { time }) })}
    </time>}
    {onQuote && <MessageAction tooltip={t('reply')} onClick={() => onQuote(quotable(quoteText ?? copyText))}><Quote aria-hidden="true" /></MessageAction>}
    <CopyAction text={copyText} />
    {children}
  </MessageActions>
}
