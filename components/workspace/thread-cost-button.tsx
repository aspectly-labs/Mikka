'use client'

import useSWR from 'swr'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { readThreadCost } from '@/app/actions/task-runs'
import { MACHINE_SIZES } from '@/lib/cloud-computer/machine-pricing'
import { modelDisplayName } from '@/lib/model-display-name'
import type { ThreadCost, ThreadCostAmount, ThreadMachineCost, ThreadModelCost } from '@/lib/thread-cost'

export const threadCostKey = (runId: string) => ['thread-cost', runId] as const
/** The popover's per-model and per-machine read; the thread panel rereads it with threadCostKey while it is open. */
export const threadCostBreakdownKey = (runId: string) => ['thread-cost', runId, 'breakdown'] as const

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

export type ThreadCostBreakdown = { models: ThreadModelCost[]; machines: ThreadMachineCost[] }

/**
 * The popover's breakdown (Figma 1318:2 section 14, 「模型与机器」): readThreadCost grouped by model and by machine,
 * read only while the popover is open. A refusal is a failed read, never an empty breakdown.
 */
export function useThreadCostBreakdown(runId: string, open: boolean) {
  const { data, error, mutate } = useSWR(open ? threadCostBreakdownKey(runId) : null, async (): Promise<ThreadCostBreakdown> => {
    const [byModel, byMachine] = await Promise.all([readThreadCost(runId, 'model'), readThreadCost(runId, 'machine')])
    if (!('totals' in byModel) || !('totals' in byMachine)) throw new Error('thread cost breakdown refused')
    return { models: byModel.models ?? [], machines: byMachine.machines ?? [] }
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  return { breakdown: data ?? null, failed: Boolean(error) && !data, retry: () => { void mutate() } }
}

export type ThreadCostRow = { id: 'credits' | 'included' | 'covered'; label: string; value: string; note?: string }
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
  const amount = money(pending ? floor : credits.microUsd)
  // The panel shows what has settled, even under a cent; only nothing settled at all reads as settling.
  const settled = pending && credits.microUsd === 0 ? t('settling') : money(credits.microUsd)
  const rows: ThreadCostRow[] = [{ id: 'credits', label: t('credits'), value: settled, note: pending ? t('unsettled', { count: credits.unpricedReceipts }) : undefined }]
  const includedPriced = included.microUsd > 0
  const includedUnpriced = included.unpricedReceipts > 0
  const hasIncluded = includedPriced || includedUnpriced
  if (hasIncluded) rows.push({
    id: 'included', label: t('included'),
    value: includedPriced ? money(included.microUsd) : t('calls', { count: included.unpricedReceipts }),
    note: includedPriced && includedUnpriced ? t('unpricedCalls', { count: included.unpricedReceipts }) : undefined,
  })
  // Platform-funded turns, once receipts say which (ThreadCost.totals.covered): muted, never part of the charge.
  const covered = cost.totals.covered
  if (covered && (covered.microUsd > 0 || covered.unpricedReceipts > 0)) rows.push({
    id: 'covered', label: t('covered'), value: covered.microUsd > 0 ? money(covered.microUsd) : t('calls', { count: covered.unpricedReceipts }),
  })
  if (settling) return { figure: t('settling'), label: t('labelSettling'), title: t('title'), rows, note: hasIncluded ? t('includedNote') : undefined }
  return {
    figure: pending ? `${amount}+` : amount,
    label: t(pending ? 'labelAtLeast' : 'label', { amount }),
    title: t('title'),
    rows,
    note: hasIncluded ? t('includedNote') : undefined,
  }
}

/** One line of the breakdown: what it is, a muted detail, and its amount. */
export type ThreadCostBreakdownRow = { key: string; label: string; detail?: string; value: string }
/** What went through Mikka, then, under its own heading, what the person's own subscription or key paid. */
export type ThreadCostBreakdownRows = { charged: ThreadCostBreakdownRow[]; included: ThreadCostBreakdownRow[] }

/**
 * The breakdown's words, by the same rules as the header (useThreadCostText), after Capy's 「Models and machines」:
 * - 「经由 Mikka」 lists what settlement recorded. A row with calls still settling is a floor cut to whole cents with a
 *   "+", or 结算中 under a cent; never a zero. A line with nothing charged is left out.
 * - Usage on the person's own subscription or key is its own list, one line per model and source, never added to the
 *   Mikka figure. A subscription call has no per-call price, so it is counted, not priced.
 * - A machine is billed from its prepaid chunks (chargedMicroUsd); one Mikka did not bill is not a charge and is left out.
 */
export function useThreadCostBreakdownRows(breakdown: ThreadCostBreakdown): ThreadCostBreakdownRows {
  const t = useTranslations('IssueThreads.cost')
  const format = useFormatter()
  const money = (microUsd: number) => microUsd > 0 && microUsd < 10_000
    ? t('underCent', { amount: format.number(0.01, CURRENCY) })
    : format.number(microUsd / 1e6, CURRENCY)
  const charge = ({ microUsd, unpricedReceipts }: ThreadCostAmount) => {
    if (!unpricedReceipts) return microUsd > 0 ? money(microUsd) : null
    const floor = Math.floor(microUsd / 10_000) * 10_000
    return floor > 0 ? `${money(floor)}+` : t('settling')
  }
  const own = ({ microUsd, unpricedReceipts }: ThreadCostAmount) =>
    microUsd > 0 ? money(microUsd) : unpricedReceipts > 0 ? t('calls', { count: unpricedReceipts }) : null
  const duration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    if (minutes < 1) return t('underMinute')
    return minutes < 60 ? t('minutes', { minutes }) : t('hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  }
  const charged: ThreadCostBreakdownRow[] = []
  const included: ThreadCostBreakdownRow[] = []
  // Machines first, as Capy lists them, then the models.
  for (const row of breakdown.machines) {
    const value = row.billing === 'unbilled' ? null : charge({ microUsd: row.chargedMicroUsd, unpricedReceipts: row.unpricedReceipts })
    if (!value) continue
    const size = row.size ? MACHINE_SIZES[row.size] : null
    charged.push({ key: `machine:${row.billing}:${row.size ?? ''}`, value, detail: duration(row.seconds),
      label: size ? t('machineSized', { vcpu: size.vcpu, gib: size.gib }) : t('machine') })
  }
  for (const row of breakdown.models) {
    const label = modelDisplayName(row.model).name || row.model
    const value = charge(row.bySource.credits)
    if (value) charged.push({ key: `model:${row.model}`, label, value })
    for (const source of ['subscription', 'api_key'] as const) {
      const paid = own(row.bySource[source])
      if (paid) included.push({ key: `${source}:${row.model}`, label, detail: t(source === 'subscription' ? 'viaSubscription' : 'viaApiKey'), value: paid })
    }
  }
  return { charged, included }
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
