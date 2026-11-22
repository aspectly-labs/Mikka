'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'
import { chatStampText } from '@/lib/chat-time-stamps'

/** The centred time above a group of chat messages (#2922, Figma 1318:3): 「今天 14:32」. */
export function MessageTimeStamp({ at }: { at: number }) {
  const t = useTranslations('ChatTime')
  const locale = useLocale()
  // Today and yesterday are read when the stamp first draws; a chat left open past midnight keeps its words until it redraws.
  const [now] = useState(() => Date.now())
  return <p data-time-stamp="" className="text-center text-xs text-muted-foreground tabular-nums">
    <time dateTime={new Date(at).toISOString()}>{chatStampText(at, now, locale, { today: time => t('today', { time }), yesterday: time => t('yesterday', { time }) })}</time>
  </p>
}
