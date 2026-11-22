'use client'

import useSWR from 'swr'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { readThreadCost } from '@/app/actions/task-runs'
import type { ThreadCost } from '@/lib/thread-cost'

export const threadCostKey = (runId: string) => ['thread-cost', runId] as const

/**
 * What a thread has cost (readThreadCost, #2934), or null until a read succeeds. A refusal ({ error }, not the
 * thread's owner) or anything that is not a cost stays null, so nothing is drawn. The thread panel rereads it on its
 * runs' live activity (threadCostKey), never on a timer.
 */
export function useThreadCost(runId: string): ThreadCost | null {
  const { data } = useSWR(threadCostKey(runId), () => readThreadCost(runId, 'thread'),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: false })
  return data && 'totals' in data && data.totals ? data : null
}

export type ThreadCostRow = { label: string; value: string; note?: string }
export type ThreadCostText = {
  /** What the header shows: an amount, or a word while nothing has settled. */
  figure: string
  /** The trigger's accessible name, without the "+" a screen reader drops. */
  label: string
  title: string
  rows: ThreadCostRow[]
  /** Only when the person's own subscription or key paid for some of it. */
  note?: string
}

/** "$1.24" in every locale, as Figma and the billing pages show it (components/billing/balance-section.tsx). */
const CURRENCY = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 } as const

/**
 * The words and figures for a thread's cost, shared by every header that draws it:
 * - The figure is the cost of the thread's calls and machine time billed through Mikka, as settlement recorded each
 *   receipt, the same cost the billing usage pages sum (lib/billing/management.ts). It is not what a workspace was
 *   debited: a free turn is the platform's, and receipts do not say which (#2934 follow-up).
 * - Receipts not settled yet are never read as zero: the sum is cut to whole cents and gets a "+", and with less than
 *   a cent settled the figure is a word (结算中). The panel counts what is still settling.
 * - A settled charge under a cent reads "<$0.01", never "$0.00".
 * - Usage paid by the person's own subscription or API key is its own row and never added to the charge. A
 *   subscription call has no per-call price (lib/secrets/run-events.ts records it with no cost), so those calls are
 *   counted, never called "settling".
 */
export function useThreadCostText(cost: ThreadCost): ThreadCostText {
  const t = useTranslations('IssueThreads.cost')
  const format = useFormatter()
  const money = (microUsd: number) => microUsd > 0 && microUsd < 10_000
    ? t('underCent', { amount: format.number(0.01, CURRENCY) })
    : format.number(microUsd / 1e6, CURRENCY)
  const { credits, included } = cost.totals
  const pending = credits.unpricedReceipts > 0
  // With calls still settling the figure is a floor, so it is cut to whole cents, never rounded up; under a cent
  // settled it is no floor at all and reads as settling.
  const floor = Math.floor(credits.microUsd / 10_000) * 10_000
  const settling = pending && floor === 0
  const amount = pending ? money(floor) : money(credits.microUsd)
  const rows: ThreadCostRow[] = [{
    label: t('credits'),
    value: settling ? t('settling') : money(credits.microUsd),
    note: credits.unpricedReceipts > 0 ? t('unsettled', { count: credits.unpricedReceipts }) : undefined,
  }]
  const usedOwn = included.microUsd > 0 || included.unpricedReceipts > 0
  if (usedOwn) rows.push({
    label: t('included'),
    value: included.microUsd > 0 ? money(included.microUsd) : t('calls', { count: included.unpricedReceipts }),
    note: included.microUsd > 0 && included.unpricedReceipts > 0 ? t('unpricedCalls', { count: included.unpricedReceipts }) : undefined,
  })
  return {
    figure: settling ? t('settling') : amount + (pending ? '+' : ''),
    label: settling ? t('labelSettling') : pending ? t('labelAtLeast', { amount }) : t('label', { amount }),
    title: t('title'),
    rows,
    note: usedOwn ? t('includedNote') : undefined,
  }
}

/**
 * The thread header's cost (#2922 item 1, Figma 1318:2 section 01), as the community header draws it. The hosted
 * header draws its own control from useThreadCost and useThreadCostText.
 */
export function ThreadCostButton({ runId }: { runId: string }) {
  const cost = useThreadCost(runId)
  return cost ? <ThreadCostView cost={cost} /> : null
}

export function ThreadCostView({ cost }: { cost: ThreadCost }) {
  const text = useThreadCostText(cost)
  return <Popover>
    <PopoverTrigger render={<Button variant="ghost" size="sm" data-slot="thread-cost"
      className="shrink-0 px-2 tabular-nums text-muted-foreground" aria-label={text.label} />}>
      {text.figure}
    </PopoverTrigger>
    <PopoverContent align="end" className="flex w-64 flex-col gap-2 p-3" aria-label={text.title}>
      <span className="text-xs font-medium">{text.title}</span>
      {text.rows.map(row => <div key={row.label} className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{row.label}</span>
          <span className="tabular-nums">{row.value}</span>
        </div>
        {row.note && <p className="text-xs text-muted-foreground">{row.note}</p>}
      </div>)}
      {text.note && <p className="text-xs text-muted-foreground">{text.note}</p>}
    </PopoverContent>
  </Popover>
}
