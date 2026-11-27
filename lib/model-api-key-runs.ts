import type { Pool, PoolClient } from 'pg'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'
import { runControlChanged } from './device-gateway-notify'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * Withdrawing an API key stops the runs it was handed to, as
 * stopRunsUsingSubscriptions does for subscriptions (orchestration.md § 2):
 * removing the key, or changing its endpoint, stops every run on it; a person
 * leaving a workspace stops that workspace's runs on their own keys; the admin
 * turning 团队权限 › 订阅与 API Key off stops that workspace's runs on members'
 * own keys (personalOnly), never those on the workspace's keys. Keys are a
 * person's or a workspace's and never shared (decision 2026-11-27-1740), so no
 * other member's run can hold someone's personal key. The daemon then wipes the
 * injected key.
 */
export async function stopRunsUsingApiKeys(query: Query, scope: { keyId?: string; ownerId?: string; workspaceId?: string; personalOnly?: boolean }) {
  if (!scope.keyId && !scope.workspaceId) throw new Error('stopRunsUsingApiKeys needs a key or a workspace')
  const { rowCount, rows } = await query.query<{ id: string }>(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM model_api_key_runs m JOIN model_api_keys k ON k.id=m."keyId"
    WHERE m."runId"=r.id AND r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
      AND ($1::uuid IS NULL OR k.id=$1) AND ($2::text IS NULL OR k."ownerId"=$2) AND ($3::text IS NULL OR m."workspaceId"::text=$3)
      AND (NOT $4::boolean OR k."ownerId" IS NOT NULL)
    RETURNING r.id`,
  [scope.keyId ?? null, scope.ownerId ?? null, scope.workspaceId ?? null, scope.personalOnly ?? false])
  for (const { id } of rows) { await runListChanged(query, id); await runChanged(query, id) }
  runControlChanged(query, { runIds: rows.map(row => row.id) })
  // Their leases ended now: if the daemon never reports the stop, run recovery reclaims them (#1212).
  if (rows.length) armDueTimerAfterCommit(query, 'run-recovery')
  return rowCount ?? 0
}
