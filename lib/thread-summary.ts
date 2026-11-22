import 'server-only'
import type { Pool } from 'pg'
import { readRunChain } from './run-chain'
import { readThreadCost, type ThreadCost } from './thread-cost'
import { readThreadMachinePlacement } from './thread-machine-view'
import { readContextUsage } from './context-usage-read'
import { catalogIdFor, catalogModel, type CatalogModel } from './model-catalog'
import type { MachineSize } from './cloud-computer/machine-pricing'
import type { ThreadMachineKind, ThreadMachineState } from './thread-machine'

/**
 * A thread's summary for its header and right column (#2935, the Figma
 * contract on page 1318:2, section 01): cost, machine, repository, branch and
 * context, in one read. Every field is what Mikka already records for the run
 * chain; a field nothing records is null, never a guess or a default.
 */
export interface ThreadSummary {
  threadId: string
  /** readThreadCost's two columns. Unpriced receipts are counted, never read as zero, so there is no single USD figure. */
  cost: ThreadCost['totals']
  /** Where the live run runs (readThreadMachine). `size` is a Cloudflare task machine's created size, else null. */
  machine: { kind: ThreadMachineKind; size: MachineSize | null; state: ThreadMachineState } | null
  /** The repository's logical identity (packages/protocol/src/repository.ts), never a path on a person's computer. */
  repo: { key: string; name: string } | null
  /** The task branch the server issued for the run's push (run_publications); null for a run that does not push. */
  branch: string | null
  context: {
    /** `used` is lib/context-usage.ts's character estimate, not a provider count. */
    estimated: true
    used: number
    /** The model's context window from the model catalogue; null when the model is unknown or the catalogue has no window. */
    max: number | null
    /** The catalogue id when the model maps onto one, else the recorded model id. */
    model: string | null
  }
}

type RepoRow = { publicationKey: string | null; branch: string | null; bindingKey: string | null; bindings: number; repoPath: string | null }

/** `owner/repo` for GitHub; the last two segments of any other repository key. */
function repositoryName(key: string): string {
  return key.split('/').filter(Boolean).slice(-2).join('/').replace(/\.git$/, '')
}

/**
 * The summary of the thread containing `runId`, or null when `ownerId` does
 * not own that run in `workspaceId`. The ownership fence is readThreadCost's
 * (the run chain's owner, every run in the workspace), so a teammate, another
 * workspace or a foreign run reads nothing.
 */
export async function readThreadSummary(
  pool: Pick<Pool, 'query'>,
  input: { ownerId: string; workspaceId: string; runId: string; catalogue: readonly CatalogModel[] },
): Promise<ThreadSummary | null> {
  const cost = await readThreadCost(pool, { ownerId: input.ownerId, workspaceId: input.workspaceId, runId: input.runId, groupBy: 'thread' })
  if (!cost) return null
  const chain = await readRunChain(pool, input.ownerId, cost.threadId)
  if (!chain) return null
  const runIds = chain.attempts.map(attempt => attempt.runId)

  const [placement, usage, { rows: repoRows }] = await Promise.all([
    readThreadMachinePlacement(pool, input.ownerId, runIds),
    readContextUsage(pool, runIds, chain.rootRunId, chain.latestRunId),
    pool.query<RepoRow & { runId: string }>(`SELECT r.id::text AS "runId",pub."remoteKey" AS "publicationKey",pub.branch,
        b."repositoryKey" AS "bindingKey",coalesce(b.n,0)::int AS bindings,p."repoPath"
      FROM agent_runs r
      LEFT JOIN run_publications pub ON pub."runId"=r.id AND pub."userId"=r."userId"
      LEFT JOIN device_repos p ON p.id=r."deviceRepoId" AND p."userId"=r."userId" AND p."deviceId"=r."deviceId"
      LEFT JOIN LATERAL (SELECT (array_agg("repositoryKey"))[1] AS "repositoryKey",count(*) AS n FROM coding_workspace_bindings
        WHERE "runId"=r.id AND "ownerId"=r."userId" AND "workspaceId"=r."workspaceId") b ON true
      WHERE r.id=ANY($1::uuid[]) AND r."userId"=$2 AND r."workspaceId"=$3`, [runIds, input.ownerId, input.workspaceId]),
  ])

  // The live end of the chain decides; an earlier attempt stands in while the newest records nothing.
  const byRun = new Map(repoRows.map(row => [row.runId, row]))
  const keyOf = (row: RepoRow) => row.publicationKey ?? (row.bindings === 1 ? row.bindingKey : null)
    // A device repo's path is a logical key only for a cloud checkout; a local path stays on the server.
    ?? (row.repoPath?.startsWith('v2/') ? row.repoPath : null)
  const source = [...runIds].reverse().map(id => byRun.get(id)).find(row => row && keyOf(row))
  const key = source ? keyOf(source) : null

  const recorded = usage.composerModel?.served ?? usage.composerModel?.selected ?? usage.model
  const catalogId = recorded ? catalogIdFor(recorded) : null
  const entry = catalogId ? catalogModel(catalogId, input.catalogue) : undefined

  return {
    threadId: cost.threadId,
    cost: cost.totals,
    machine: placement ? { kind: placement.machine.kind, size: placement.size, state: placement.machine.state } : null,
    repo: key ? { key, name: repositoryName(key) } : null,
    branch: source?.branch ?? null,
    context: { estimated: true, used: usage.used, max: entry?.contextWindow ?? null, model: entry?.id ?? recorded ?? null },
  }
}
