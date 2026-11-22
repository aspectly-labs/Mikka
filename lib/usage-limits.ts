import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

/**
 * A subscription that hit its usage limit and the threads it paused (#2938): `{provider, resetsAt, pausedThreadIds}`.
 * It is a projection of what the completion path already records, never a second record. A run that ran out of quota
 * with nothing to go on with is written `paused` / `pauseReason='quota_exhausted'` with `quotaResetsAt`, and its
 * `run_quota_paused` coordinator event names the subscription (lib/run-quota.ts). That write already pushes the
 * owner's `thread_list` change on the live channel (runListChanged), so a client re-reads this when it arrives.
 * Each thread is named by its paused run, the run the thread's resume and retry act on.
 */
export interface UsageLimit {
  provider: 'claude' | 'codex'
  /** The subscription (byos_connections id); null for a device's own CLI login. */
  connectionId: string | null
  /** The latest reset among the paused runs; null when the provider did not say. */
  resetsAt: string | null
  pausedThreadIds: string[]
}

type Query = Pick<Pool | PoolClient, 'query'>

/** The owner's own quota-paused runs in one workspace, one entry per subscription. Nobody else's runs are read. */
export async function readUsageLimits(query: Query, ownerId: string, workspaceId: string): Promise<UsageLimit[]> {
  z.uuid().parse(workspaceId)
  const { rows } = await query.query<{ runId: string; provider: string | null; connectionId: string | null; resetsAt: Date | null }>(
    `SELECT r.id::text AS "runId",e.payload->>'provider' AS provider,e.payload->>'connectionId' AS "connectionId",r."quotaResetsAt" AS "resetsAt"
      FROM agent_runs r
      JOIN LATERAL (SELECT payload FROM coordinator_events e WHERE e."runId"=r.id AND e."userId"=r."userId" AND e.kind='run_quota_paused'
        ORDER BY e."createdAt" DESC LIMIT 1) e ON true
      WHERE r."userId"=$1 AND r."workspaceId"=$2 AND r.status='paused' AND r."pauseReason"='quota_exhausted'
      ORDER BY r."createdAt",r.id`, [ownerId, workspaceId])
  const limits = new Map<string, UsageLimit & { unknown: boolean }>()
  for (const row of rows) {
    const provider = row.provider === 'codex' ? 'codex' : 'claude'
    const key = `${provider}:${row.connectionId ?? ''}`
    const limit = limits.get(key) ?? { provider, connectionId: row.connectionId, resetsAt: null, pausedThreadIds: [], unknown: false }
    limit.pausedThreadIds.push(row.runId)
    const resetsAt = row.resetsAt?.toISOString() ?? null
    // Every paused run waits for its own window: the group is free once the latest one resets, unknown if any is.
    if (!resetsAt) limit.unknown = true
    else if (!limit.resetsAt || resetsAt > limit.resetsAt) limit.resetsAt = resetsAt
    limits.set(key, limit)
  }
  return [...limits.values()].map(({ unknown, ...limit }) => ({ ...limit, resetsAt: unknown ? null : limit.resetsAt }))
}
