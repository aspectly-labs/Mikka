import type { Pool, PoolClient } from 'pg'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'
import { runControlChanged } from './device-gateway-notify'
import { armDueTimerAfterCommit } from './due-timer'
import { readBatchSubscriptionPolicy } from './desktop-rpc/read-batch-context'
import { workspaceResourcePolicy } from './governance/resource-access'

/**
 * Decision 2026-11-17: a Claude or Codex subscription serves its owner only; no
 * other member's bot or run can use it. Decision 2026-11-27-1740: the same holds
 * for API keys; a workspace adds its own keys instead, and the team admin switch
 * 团队权限 › 订阅与 API Key decides whether members' own API keys are used for
 * their runs in that workspace (on: their own first, then the workspace's; off:
 * the workspace's keys only).
 */
type Query = Pick<Pool | PoolClient, 'query'>

/**
 * The team admin switch 团队权限 › 订阅与 API Key as stored for the workspace; an
 * absent row (and every personal workspace) means on. Members' own API keys serve
 * their runs in this workspace only while it is on (decision 2026-11-27-1740).
 */
export async function workspaceMemberCredentialsAllowed(query: Query, workspaceId: string): Promise<boolean> {
  return readBatchSubscriptionPolicy(query, workspaceId, async () => {
    const { rows: [row] } = await query.query<{ subscriptions: boolean }>('SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1', [workspaceId])
    return row?.subscriptions ?? true
  })
}

/** The switch as the settings page shows it: also off when the Organization denies member credentials. */
export async function memberSubscriptionsAllowed(query: Query, workspaceId: string): Promise<boolean> {
  if ((await workspaceResourcePolicy(workspaceId)).modelCredentialSharing === 'deny') return false
  return workspaceMemberCredentialsAllowed(query, workspaceId)
}

/** SQL for the same switch: true unless the workspace turned members' own credentials off. */
export const memberCredentialsAllowedSql = (workspace: string) =>
  `NOT EXISTS (SELECT 1 FROM workspace_personal_policies mp WHERE mp."workspaceId"::text=(${workspace})::text AND NOT mp.subscriptions)`

/**
 * Withdrawing a credential stops the runs using it now: disconnecting or leaving
 * stops all of them. It goes through the usual
 * stop request and lease cut: the device's daemon ends the run and deletes the
 * short-lived credential it was given, and every credential access or renewal
 * already refuses a run with a stop request. The running CLI is stopped through
 * its control channel; provider and tool calls add no authorization round trip.
 * At least a workspace or a connection, so it can never stop everything.
 * Returns how many runs it newly stopped.
 */
export async function stopRunsUsingSubscriptions(query: Query, scope: { ownerId?: string; workspaceId?: string; connectionId?: string }) {
  if (!scope.workspaceId && !scope.connectionId) throw new Error('stopRunsUsingSubscriptions needs a workspace or a connection')
  const { rowCount, rows } = await query.query<{ id: string }>(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM byos_native_runs n JOIN byos_bindings b ON b.id=n."bindingId" JOIN byos_connections c ON c.id=b."connectionId"
    WHERE n."runId"=r.id AND r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
      AND ($1::text IS NULL OR c."ownerId"=$1) AND ($2::text IS NULL OR b."workspaceId"::text=$2)
      AND ($3::uuid IS NULL OR c.id=$3) RETURNING r.id`,
    [scope.ownerId ?? null, scope.workspaceId ?? null, scope.connectionId ?? null])
  for (const { id } of rows) { await runListChanged(query, id); await runChanged(query, id) }
  runControlChanged(query, { runIds: rows.map(row => row.id) })
  if (rows.length) armDueTimerAfterCommit(query, 'run-recovery')
  return rowCount ?? 0
}

/**
 * SQL for a run's subscription (decision 2026-11-17: a subscription serves its
 * owner only): may the credential owner's subscription serve the run owner's
 * run? Only when they are the same person. Membership lives in the workspace
 * database, so callers still check it there (authorizeSubscriptionWorkspace).
 */
export const runMayUseCredentialSql = (credentialOwner: string, runOwner: string, workspace: string) =>
  // The workspace expression stays referenced (and typed) so a caller's bound
  // parameter for it remains inferable; it no longer widens the grant.
  `(${credentialOwner}=${runOwner} AND ((${workspace})::text IS NULL OR true))`
