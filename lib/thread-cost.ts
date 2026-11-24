import { readRunChain, type RunChainQueryable } from './run-chain'
import { isMachineSize, machineHourlyMicroUsd, type MachineSize } from './cloud-computer/machine-pricing'
import { THREAD_COST_GROUPINGS, type ThreadCostGrouping } from './thread-cost-grouping'

export { THREAD_COST_GROUPINGS, type ThreadCostGrouping }

/**
 * A thread's cost (#2934 item 4): every model receipt and machine charge of the
 * runs in one run chain, read from hosted_usage and thread_machine_sessions.
 * Nothing here is a price list: model cost is what settlement recorded, and a
 * machine's metered cost uses the same per-GiB-hour rate as its prepaid chunks.
 *
 * What counts as charged (#2934, as Capy: free usage is never shown as a charge).
 * Settlement (HostedUsageStore.settle) splits a Mikka 额度 receipt's cost and records
 * the part the platform funded in hosted_usage."platformMicroUsd":
 * - charged, the workspace's own money: plan allowance (Mikka Pro's monthly 额度, paid
 *   for by the plan), purchased credit, and debt (an overrun past purchased credit,
 *   which the workspace owes and repays from its next credit);
 * - covered, funded by the platform: a free-message turn (no card, nothing bought,
 *   the whole cost) and free credit (a hosted_allowances grant made before the
 *   2026-11-15 no-trial decision).
 * A receipt settled before that column existed has NULL: its funding is unknown and is
 * counted apart, as neither charged nor covered. "unpaidMicroUsd" cannot stand in for
 * it: it counts free credit and debt together for the platform's daily cap.
 */

/** Who paid: Mikka 额度, the person's subscription (Claude / Codex) or their own API key. */
export type ThreadCostSource = 'credits' | 'subscription' | 'api_key'

export interface ThreadCostAmount {
  /** Sum of settled receipts that report a cost. */
  microUsd: number
  /** Receipts with no known cost yet (pending, unknown, or a provider that reports none). Never read as zero. */
  unpricedReceipts: number
}

/** Settled Mikka 额度 receipts with a known cost, split apart from what was charged. */
export interface ThreadFundingAmount {
  /** List cost of these receipts (or of their platform-funded part). */
  microUsd: number
  /** How many receipts contributed to `microUsd`. */
  receipts: number
}

export interface ThreadModelCost {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** `credits` is what the workspace was charged on Mikka 额度; see the module comment. */
  bySource: Record<ThreadCostSource, ThreadCostAmount>
  /** This model's Mikka 额度 usage the platform funded: not charged. */
  covered: ThreadFundingAmount
  /** This model's settled Mikka 额度 receipts whose funding was not recorded: neither charged nor covered. */
  fundingUnknown: ThreadFundingAmount
}

/**
 * One row per machine size. `billing` says how the row's running time is priced:
 * `metered` at the size's rate; `unknown_size` when Mikka billed the run but its
 * size is unrecognised or changed within the run (no rate is guessed); `unbilled`
 * when the run's cloud machine has no Mikka charge at all (no prepaid chunk).
 */
export interface ThreadMachineCost {
  size: MachineSize | null
  billing: 'metered' | 'unknown_size' | 'unbilled'
  /** Running time recorded per interval in thread_machine_sessions, to the second; an open interval counts up to now. */
  seconds: number
  /** seconds × the size's hourly rate; null unless `billing` is `metered`. */
  meteredMicroUsd: number | null
  /** What the workspace was charged for its 5-minute prepaid chunks from Mikka 额度 (decision 2026-11-15-1900). */
  chargedMicroUsd: number
  /** The platform-funded part of those chunks: not charged. */
  coveredMicroUsd: number
  /** Settled chunks whose funding was not recorded: neither charged nor covered. */
  fundingUnknownMicroUsd: number
  /** Prepaid chunks with no settled cost yet. */
  unpricedReceipts: number
}

export interface ThreadCost {
  threadId: string
  groupBy: ThreadCostGrouping
  /** Two columns in the UI: Mikka 额度, and usage included in the person's own subscription or key. */
  totals: {
    /**
     * What the workspace was charged on Mikka 额度 (plan, purchased credit, debt). Covered and
     * unknown-funding receipts are not in it; unpriced ones (no cost yet) are counted here.
     */
    credits: ThreadCostAmount
    included: ThreadCostAmount & { bySource: Record<Exclude<ThreadCostSource, 'credits'>, ThreadCostAmount> }
    /**
     * Mikka 额度 usage the platform funded (a free-message turn, free credit), at list cost: shown apart, never
     * as a charge.
     */
    covered: ThreadFundingAmount
    /** Mikka 额度 receipts settled before funding was recorded: cost known, who paid unknown. Neither charged nor covered. */
    fundingUnknown: ThreadFundingAmount
  }
  models?: ThreadModelCost[]
  machines?: ThreadMachineCost[]
}

const MACHINE_PREFIX = 'machine/cloudflare-'
const amount = (): ThreadCostAmount => ({ microUsd: 0, unpricedReceipts: 0 })
const add = (target: ThreadCostAmount, cost: number | null) => {
  if (cost === null) target.unpricedReceipts++
  else target.microUsd += cost
}
const sourceOf = (value: unknown): ThreadCostSource =>
  value === 'subscription' || value === 'api_key' ? value : 'credits'
const funded = (): ThreadFundingAmount => ({ microUsd: 0, receipts: 0 })
const fund = (target: ThreadFundingAmount, value: number) => {
  target.microUsd += value
  target.receipts++
}
/** How a Mikka 额度 receipt's cost divides: unpriced (no cost yet), unknown funding, or charged plus covered. */
type Funding = { kind: 'unpriced' } | { kind: 'unknown'; cost: number } | { kind: 'known'; charged: number; covered: number }
const fundingOf = (cost: number | null, platform: unknown): Funding => {
  if (cost === null) return { kind: 'unpriced' }
  if (platform === null || platform === undefined) return { kind: 'unknown', cost }
  const covered = Math.min(cost, Math.max(0, Number(platform)))
  return { kind: 'known', charged: cost - covered, covered }
}

/**
 * The cost of the thread containing `runId`, or null when `ownerId` does not
 * own that run in `workspaceId`. Ownership is the run chain's own fence
 * (readRunChain), so another member of the workspace reads nothing.
 */
export async function readThreadCost(
  q: RunChainQueryable,
  input: { ownerId: string; workspaceId: string; runId: string; groupBy: ThreadCostGrouping },
): Promise<ThreadCost | null> {
  if (!(THREAD_COST_GROUPINGS as readonly string[]).includes(input.groupBy)) return null
  // A corrupt chain (cycle or over the depth cap) throws runChainDepthExceeded, like every other chain read.
  const chain = await readRunChain(q, input.ownerId, input.runId)
  if (!chain) return null
  const runIds = chain.attempts.map(attempt => attempt.runId)
  const { rows: fenced } = await q.query(
    'SELECT count(*)::int AS n FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "workspaceId"=$3',
    [runIds, input.ownerId, input.workspaceId],
  )
  if (Number(fenced[0]?.n) !== runIds.length) return null

  // Failed receipts were released and charged nothing; every other state is real usage.
  const { rows: receipts } = await q.query(
    `SELECT id,model,"billingSource" AS source,state,"costMicroUsd" AS cost,"platformMicroUsd" AS platform,"inputTokens" AS input,"outputTokens" AS output,"usageRunId"::text AS "runId"
      FROM hosted_usage WHERE "usageRunId"=ANY($1::uuid[]) AND state<>'failed'`,
    [runIds],
  )
  // Intervals are read in the thread's own owner and workspace; time recorded after a
  // scope_changed hand-off belongs to the new scope, not to this thread's cost. Only the
  // machine grouping returns them, so other groupings skip the read entirely.
  const { rows: sessions } = input.groupBy === 'machine'
    ? await q.query(
      `SELECT "runId"::text AS "runId",
          COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE("endedAt",clock_timestamp())-"startedAt"))),0)::float8 AS seconds
        FROM thread_machine_sessions WHERE "runId"=ANY($1::uuid[]) AND "ownerId"=$2 AND "workspaceId"=$3 GROUP BY "runId"`,
      [runIds, input.ownerId, input.workspaceId],
    )
    : { rows: [] as { runId: string; seconds: number }[] }

  const credits = amount()
  const included = { ...amount(), bySource: { subscription: amount(), api_key: amount() } }
  const covered = funded()
  const fundingUnknown = funded()
  const models = new Map<string, ThreadModelCost>()
  const machines = new Map<string, ThreadMachineCost>()
  const machine = (size: MachineSize | null, billing: ThreadMachineCost['billing']) => {
    const key = billing === 'metered' ? `size:${size}` : billing
    let row = machines.get(key)
    if (!row) machines.set(key, row = { size: billing === 'metered' ? size : null, billing, seconds: 0,
      meteredMicroUsd: billing === 'metered' ? 0 : null, chargedMicroUsd: 0, coveredMicroUsd: 0, fundingUnknownMicroUsd: 0, unpricedReceipts: 0 })
    return row
  }
  // The sizes each run's prepaid chunks name. One recognised size meters the run's time at its rate;
  // several sizes or an unrecognised one leave the rate unknown rather than guessed.
  const runSizes = new Map<string, Set<string>>()

  for (const receipt of receipts) {
    const settled = receipt.state === 'settled' && receipt.cost !== null
    const cost = settled ? Number(receipt.cost) : null
    const source = sourceOf(receipt.source)
    // Only Mikka 额度 is split by funding; subscription and key usage was never charged by Mikka.
    const funding = source === 'credits' ? fundingOf(cost, receipt.platform) : null
    if (source !== 'credits') { add(included, cost); add(included.bySource[source], cost) }
    else if (funding?.kind === 'unknown') fund(fundingUnknown, funding.cost)
    else if (funding?.kind === 'known') {
      add(credits, funding.charged)
      if (funding.covered > 0) fund(covered, funding.covered)
    } else add(credits, null)
    const model = String(receipt.model)
    // A prepayment is known by machineChunkId's receipt id, never by its label alone:
    // a custom API-key provider can name a model anything, including a machine label.
    if (String(receipt.id).startsWith('machine:') && source === 'credits' && model.startsWith(MACHINE_PREFIX)) {
      const size = model.slice(MACHINE_PREFIX.length)
      const run = String(receipt.runId)
      runSizes.set(run, (runSizes.get(run) ?? new Set()).add(size))
      const row = isMachineSize(size) ? machine(size, 'metered') : machine(null, 'unknown_size')
      if (funding?.kind === 'known') { row.chargedMicroUsd += funding.charged; row.coveredMicroUsd += funding.covered }
      else if (funding?.kind === 'unknown') row.fundingUnknownMicroUsd += funding.cost
      else row.unpricedReceipts++
      continue
    }
    let row = models.get(model)
    if (!row) models.set(model, row = { model, calls: 0, inputTokens: 0, outputTokens: 0,
      bySource: { credits: amount(), subscription: amount(), api_key: amount() }, covered: funded(), fundingUnknown: funded() })
    row.calls++
    row.inputTokens += Number(receipt.input ?? 0)
    row.outputTokens += Number(receipt.output ?? 0)
    if (funding?.kind === 'known') {
      add(row.bySource.credits, funding.charged)
      if (funding.covered > 0) fund(row.covered, funding.covered)
    } else if (funding?.kind === 'unknown') fund(row.fundingUnknown, funding.cost)
    else add(row.bySource[source], cost)
  }
  for (const session of sessions) {
    const sizes = [...runSizes.get(String(session.runId)) ?? []]
    const [only] = sizes
    const row = !sizes.length ? machine(null, 'unbilled')
      : sizes.length === 1 && isMachineSize(only) ? machine(only, 'metered') : machine(null, 'unknown_size')
    const seconds = Math.max(0, Math.floor(Number(session.seconds)))
    row.seconds += seconds
    if (row.size && row.meteredMicroUsd !== null) row.meteredMicroUsd += Math.round(seconds * machineHourlyMicroUsd(row.size) / 3600)
  }

  const result: ThreadCost = { threadId: chain.rootRunId, groupBy: input.groupBy, totals: { credits, included, covered, fundingUnknown } }
  if (input.groupBy === 'model') result.models = [...models.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
  if (input.groupBy === 'machine') result.machines = [...machines.values()].sort((a, b) => b.seconds - a.seconds || b.chargedMicroUsd - a.chargedMicroUsd)
  return result
}
