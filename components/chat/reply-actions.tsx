'use client'

import type { ReactNode } from 'react'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Quote } from '@/components/icons'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { CopyAction, REPLY_ACTIONS } from '@/components/chat/copy-action'
import { cn } from '@/lib/utils'

/**
 * The line under a message (#2922, Figma `1318:59`): when it was sent, Reply, Copy, then what the caller adds (the pages
 * a reply cites, reactions). Reply quotes the whole message into the composer, the same quote 引用 makes from selected
 * words. It stays on screen, quiet until hovered (R-83 revised 2026-11-10), on every chat that draws messages through
 * ThreadScreen. The More menu waits for its first action that is not already on this line (fork, side chat and rerun
 * need #2936).
 */
export function ReplyActions({ at, copyText, onQuote, children }: {
  /** When the message was sent, as a timestamp in ms. */
  at?: number
  copyText: string
  /** Puts the message in the composer as a quote; without it there is no Reply. */
  onQuote?: (text: string) => void
  children?: ReactNode
}) {
  const t = useTranslations('AiElements.message')
  const format = useFormatter()
  return <MessageActions className={cn('items-center', REPLY_ACTIONS)} data-slot="reply-actions">
    {at !== undefined && Number.isFinite(at) && <time dateTime={new Date(at).toISOString()} className="px-1 text-xs tabular-nums text-muted-foreground">
      {format.dateTime(new Date(at), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
    </time>}
    {onQuote && <MessageAction tooltip={t('reply')} onClick={() => onQuote(copyText)}><Quote aria-hidden="true" /></MessageAction>}
    <CopyAction text={copyText} />
    {children}
  </MessageActions>
}
