import 'server-only'
import type { Pool } from 'pg'
import { readRunChain } from './run-chain'
import { readThreadMachinePlacement } from './thread-machine-view'
import type { MachineSize } from './cloud-computer/machine-pricing'
import type { ThreadMachine } from './thread-machine'

/**
 * A thread's machine workspace for the right column's Files and Setup tabs (#2928, #2940; Figma 1318:2 sections 04
 * and 05): where its files are read from, the machine it runs on, the Environment its live run was admitted with,
 * and what the person uploaded to it. Every field is what Mikka already records for the run chain; a field nothing
 * records is null or empty, never a guess.
 */
export interface ThreadWorkspace {
  threadId: string
  /** The workspace the thread is read in, which the workspace file API is scoped to. */
  workspaceId: string
  /** The chain's newest run: what the machine, the Environment and the checkout belong to. */
  liveRunId: string
  /**
   * The checkout the workspace file API reads (`/api/runs/:runId/workspace/files?repoId=`): the newest attempt with
   * exactly one repository. `key` is the logical repository identity; a path on a person's computer never leaves the
   * server, so a local checkout has a null key.
   */
  checkout: { runId: string; repoId: string; key: string | null; name: string | null } | null
  /** Where the live run runs (readThreadMachinePlacement): its kind, state, size and, for a sandbox, when it started. */
  machine: { kind: ThreadMachine['kind']; state: ThreadMachine['state']; size: MachineSize | null; name: string | null; startedAt: string | null; endedAt: string | null } | null
  /** The Environment frozen on the live run at admission (agentDefinition.projectExecution.environment). */
  environment: {
    id: string; name: string; runtime: string
    /** The setup recipe, as approved; `command` is absent when the recipe only copies files. */
    setup: { command: string | null; copyFiles: string[]; approved: boolean } | null
    repositories: string[]
  } | null
  /** Files the person sent in this thread, newest first: name, type and size; download goes through /api/chat/attachments/:id. */
  uploads: { id: string; name: string; mediaType: string; size: number; createdAt: string }[]
}

type EnvironmentSnapshot = {
  id?: unknown; name?: unknown; runtime?: unknown; repositoryKeys?: unknown
  setup?: { command?: unknown; copyFiles?: unknown; approved?: unknown } | null
}

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const repositoryName = (key: string) => key.split('/').filter(Boolean).slice(-2).join('/').replace(/\.git$/, '')

/**
 * The workspace of the thread containing `runId`, or null when `ownerId` does not own that run in `workspaceId`.
 * The fence is the run's owner and its workspace: a teammate, another workspace or a foreign run reads nothing.
 */
export async function readThreadWorkspace(
  pool: Pick<Pool, 'query'>,
  input: { ownerId: string; workspaceId: string; runId: string },
): Promise<ThreadWorkspace | null> {
  const { rows: [owned] } = await pool.query<{ id: string }>(
    'SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3', [input.runId, input.ownerId, input.workspaceId])
  if (!owned) return null
  const chain = await readRunChain(pool, input.ownerId, input.runId)
  if (!chain) return null
  const runIds = chain.attempts.map(attempt => attempt.runId)

  const [placement, { rows: runs }, { rows: uploads }] = await Promise.all([
    readThreadMachinePlacement(pool, input.ownerId, runIds),
    pool.query<{ id: string; deviceRepoId: string | null; repoPath: string | null; bindings: string[]; bindingKeys: string[]; environment: EnvironmentSnapshot | null }>(
      `SELECT r.id::text,r."deviceRepoId"::text,p."repoPath",
          coalesce(b.ids,ARRAY[]::text[]) AS bindings,coalesce(b.keys,ARRAY[]::text[]) AS "bindingKeys",
          r."agentDefinition"#>'{projectExecution,environment}' AS environment
        FROM agent_runs r
        LEFT JOIN device_repos p ON p.id=r."deviceRepoId" AND p."userId"=r."userId"
        LEFT JOIN LATERAL (SELECT array_agg("repoId"::text ORDER BY "repoId") AS ids,array_agg("repositoryKey" ORDER BY "repoId") AS keys
          FROM coding_workspace_bindings WHERE "runId"=r.id AND "ownerId"=r."userId" AND "workspaceId"=r."workspaceId") b ON true
        WHERE r.id=ANY($1::uuid[]) AND r."userId"=$2 AND r."workspaceId"=$3`, [runIds, input.ownerId, input.workspaceId]),
    pool.query<{ id: string; name: string; mediaType: string; size: number; createdAt: Date }>(
      `SELECT id::text,name,"mediaType",size,"createdAt" FROM chat_attachments
        WHERE "runId"=ANY($1::uuid[]) AND "userId"=$2 AND state='ready' AND "removedAt" IS NULL AND "usedAt" IS NOT NULL
        ORDER BY "createdAt" DESC,id LIMIT 200`, [runIds, input.ownerId]),
  ])

  const byId = new Map(runs.map(run => [run.id, run]))
  const newestFirst = [...runIds].reverse().map(id => byId.get(id)).filter(run => run !== undefined)
  // As the review's checkout (lib/coding-workspace/task-review/context.ts): one binding, else the run's device repo.
  // An attempt with two bindings, or one that disagrees with its device repo, is ambiguous and names no checkout.
  const checkoutRun = newestFirst.find(run => run.bindings.length === 1 ? !run.deviceRepoId || run.bindings[0] === run.deviceRepoId : run.bindings.length === 0 && run.deviceRepoId)
  const logicalKey = (run: NonNullable<typeof checkoutRun>) => run.bindingKeys[0] ?? (run.repoPath?.startsWith('v2/') ? run.repoPath : null)
  const checkout = checkoutRun ? {
    runId: checkoutRun.id, repoId: (checkoutRun.bindings[0] ?? checkoutRun.deviceRepoId)!,
    key: logicalKey(checkoutRun), name: logicalKey(checkoutRun) ? repositoryName(logicalKey(checkoutRun)!) : null,
  } : null

  const frozen = byId.get(chain.latestRunId)?.environment ?? newestFirst.find(run => run.environment)?.environment ?? null
  const environment = frozen && typeof frozen.id === 'string' && typeof frozen.name === 'string' ? {
    id: frozen.id, name: frozen.name, runtime: typeof frozen.runtime === 'string' ? frozen.runtime : 'any',
    setup: frozen.setup && typeof frozen.setup === 'object' ? {
      command: typeof frozen.setup.command === 'string' && frozen.setup.command.trim() ? frozen.setup.command : null,
      copyFiles: strings(frozen.setup.copyFiles), approved: frozen.setup.approved === true,
    } : null,
    repositories: strings(frozen.repositoryKeys),
  } : null

  const machine = placement ? {
    kind: placement.machine.kind, state: placement.machine.state, size: placement.size,
    // A computer's own name; a sandbox has none.
    name: placement.machine.name,
    startedAt: placement.machine.cloud?.createdAt ?? null, endedAt: placement.machine.cloud?.endedAt ?? null,
  } : null

  return {
    threadId: chain.rootRunId,
    workspaceId: input.workspaceId,
    liveRunId: chain.latestRunId,
    checkout,
    machine,
    environment,
    uploads: uploads.map(row => ({ id: row.id, name: row.name, mediaType: row.mediaType, size: row.size, createdAt: row.createdAt.toISOString() })),
  }
}

/** A recent sample of the live sandbox's load, read without waking it (as the review's machine-metrics route). */
export type ThreadMachineMetrics = { at: string; cpuCount: number; cpuUsedPct: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number }

/**
 * The latest sample of the live run's E2B sandbox over the last five minutes, or null when the thread is not the
 * owner's, runs elsewhere (a computer, a Cloudflare task machine), or has no running sandbox. It reads the provider's
 * recorded metrics and never connects to or wakes the sandbox.
 */
export async function readThreadMachineMetrics(
  pool: Pick<Pool, 'query'>,
  input: { ownerId: string; workspaceId: string; runId: string },
  read: (ownerId: string, sandboxId: string, start: Date, end: Date) => Promise<readonly unknown[]>,
): Promise<ThreadMachineMetrics | null> {
  const { rows: [owned] } = await pool.query<{ id: string }>(
    'SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3', [input.runId, input.ownerId, input.workspaceId])
  if (!owned) return null
  const chain = await readRunChain(pool, input.ownerId, input.runId)
  if (!chain) return null
  const placement = await readThreadMachinePlacement(pool, input.ownerId, chain.attempts.map(attempt => attempt.runId))
  const cloud = placement?.machine.kind === 'cloud' ? placement.machine.cloud : null
  const { hostedSnapshot } = await import('./cloud-computer/sponsored-task')
  if (!cloud || placement?.machine.state !== 'running' || cloud.template === hostedSnapshot) return null
  const end = new Date()
  const start = new Date(Math.max(end.getTime() - 5 * 60_000, Date.parse(cloud.createdAt) || end.getTime()))
  if (start >= end) return null
  let latest: ThreadMachineMetrics | null = null
  for (const row of await read(input.ownerId, cloud.sandboxId, start, end)) {
    const sample = metricSample(row)
    if (sample && (!latest || sample.at > latest.at)) latest = sample
  }
  return latest
}

function metricSample(row: unknown): ThreadMachineMetrics | null {
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  const count = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0 ? value[key] as number : null
  const at = value.timestamp instanceof Date ? value.timestamp : typeof value.timestamp === 'string' ? new Date(value.timestamp) : null
  const fields = { cpuCount: count('cpuCount'), cpuUsedPct: count('cpuUsedPct'), memUsed: count('memUsed'), memTotal: count('memTotal'), diskUsed: count('diskUsed'), diskTotal: count('diskTotal') }
  if (!at || Number.isNaN(at.getTime()) || Object.values(fields).some(field => field === null)) return null
  return { at: at.toISOString(), ...fields as { [K in keyof typeof fields]: number } }
}

/**
 * The files the person sent in their chat with a Bot, newest first, for the Files tab's Uploads view in a Bot's chat
 * (which has no machine of its own: each thread it dispatches gets one). Null when the Bot is not in `workspaceId`;
 * only the person's own uploads are read, so a teammate's chat with the same Bot stays theirs.
 */
export async function readBotChatUploads(
  pool: Pick<Pool, 'query'>,
  input: { ownerId: string; workspaceId: string; botId: string },
): Promise<ThreadWorkspace['uploads'] | null> {
  const { rows: [bot] } = await pool.query<{ id: string }>('SELECT id FROM bots WHERE id=$1 AND "workspaceId"=$2', [input.botId, input.workspaceId])
  if (!bot) return null
  const { rows } = await pool.query<{ id: string; name: string; mediaType: string; size: number; createdAt: Date }>(
    `SELECT id::text,name,"mediaType",size,"createdAt" FROM chat_attachments
      WHERE "botId"=$1 AND "userId"=$2 AND state='ready' AND "removedAt" IS NULL AND "usedAt" IS NOT NULL
      ORDER BY "createdAt" DESC,id LIMIT 200`, [input.botId, input.ownerId])
  return rows.map(row => ({ id: row.id, name: row.name, mediaType: row.mediaType, size: row.size, createdAt: row.createdAt.toISOString() }))
}
