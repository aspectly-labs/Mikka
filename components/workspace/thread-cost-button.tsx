'use client'

import useSWR from 'swr'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { readThreadCost } from '@/app/actions/task-runs'
import type { ThreadCost, ThreadCostAmount } from '@/lib/thread-cost'

export const threadCostKey = (runId: string) => ['thread-cost', runId] as const

/**
 * The thread header's cost (#2922 item 1, Figma 1318:2 section 01): what this conversation has cost in
 * Mikka 额度, as settlement recorded it (readThreadCost, #2934). Calls whose cost has not settled yet are
 * never read as zero: the figure gets a "+" and the panel counts them. Usage paid by the person's own
 * subscription or API key is shown apart, never added to what Mikka charged.
 *
 * The thread panel rereads it on its runs' live events (threadCostKey), never on a timer.
 * Nothing shows until the read succeeds: no placeholder figure, and a refused read (not the thread's owner)
 * leaves the header as it was.
 */
export function ThreadCostButton({ runId }: { runId: string }) {
  const { data } = useSWR(threadCostKey(runId), () => readThreadCost(runId, 'thread'),
    { revalidateOnFocus: true, shouldRetryOnError: false, keepPreviousData: false })
  // A refusal ({ error }) or anything that is not a cost shows nothing.
  if (!data || !('totals' in data) || !data.totals) return null
  return <ThreadCostView cost={data} />
}

export function ThreadCostView({ cost }: { cost: ThreadCost }) {
  const t = useTranslations('IssueThreads.cost')
  const format = useFormatter()
  const usd = (microUsd: number) => format.number(microUsd / 1e6, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const figure = (value: ThreadCostAmount) => usd(value.microUsd) + (value.unpricedReceipts > 0 ? '+' : '')
  const { credits, included } = cost.totals
  const hasIncluded = included.microUsd > 0 || included.unpricedReceipts > 0
  const amount = figure(credits)
  return <Popover>
    <PopoverTrigger render={<Button variant="ghost" size="sm" data-slot="thread-cost"
      className="shrink-0 px-2 tabular-nums text-muted-foreground" aria-label={t('label', { amount })} />}>
      {amount}
    </PopoverTrigger>
    <PopoverContent align="end" className="flex w-64 flex-col gap-2 p-3">
      <span className="text-xs font-medium">{t('title')}</span>
      <dl className="flex flex-col gap-1">
        <Row label={t('credits')} value={figure(credits)} />
        {credits.unpricedReceipts > 0 && <p className="text-xs text-muted-foreground">{t('unpriced', { count: credits.unpricedReceipts })}</p>}
        {hasIncluded && <Row label={t('included')} value={figure(included)} />}
        {hasIncluded && included.unpricedReceipts > 0 && <p className="text-xs text-muted-foreground">{t('unpriced', { count: included.unpricedReceipts })}</p>}
      </dl>
      <p className="text-xs text-muted-foreground">{hasIncluded ? t('includedNote') : t('note')}</p>
    </PopoverContent>
  </Popover>
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between gap-2 text-xs">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="tabular-nums">{value}</dd>
  </div>
}
