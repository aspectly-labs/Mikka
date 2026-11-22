'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { CalendarClock, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'

export type QueuedMessage = {
  id: string
  text: string
  /** What the row says instead of its actions: 正在发送, or why it did not go. */
  note?: string
  /** 立即发送: only where the run takes a message mid-turn. */
  onSendNow?: () => void
  /** 删除: the existing cancel; absent once it can no longer be taken back. */
  onDelete?: () => void
}

/**
 * Messages waiting for the thread, above the composer (Figma `1318:2` section 20, #2926): 「排队 · N」, when they go,
 * and each one with 立即发送 and 删除. Mikka has no write that changes a queued message's words, so there is no 编辑.
 */
export function ThreadQueuedMessages({ rows, paused }: { rows: QueuedMessage[]; paused?: boolean }) {
  const t = useTranslations('ThreadUnderComposer.queued')
  if (!rows.length) return null
  return <section data-slot="thread-queued" aria-label={t('title', { count: rows.length })} aria-live="polite"
    className="flex min-w-0 flex-col rounded-xl border border-rule bg-card py-1 text-xs">
    <header className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{t('title', { count: rows.length })}</span>
      <span className="shrink-0">{paused ? t('whenContinued') : t('afterTurn')}</span>
    </header>
    <ul className="flex min-w-0 flex-col">
      {rows.map(row => <li key={row.id} data-queued-message={row.id} className="flex min-h-8 min-w-0 items-center gap-2 px-3">
        <CalendarClock aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={row.text}>{row.text}</span>
        {row.note && <span className="shrink-0 text-muted-foreground">{row.note}</span>}
        {row.onSendNow && <Button type="button" size="xs" variant="ghost" onClick={row.onSendNow}>{t('sendNow')}</Button>}
        {row.onDelete && <Button type="button" size="icon-xs" variant="ghost" aria-label={t('delete')} title={t('delete')} onClick={row.onDelete}><Trash2 /></Button>}
      </li>)}
    </ul>
  </section>
}
