import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { readGovernanceLease } from '@/lib/governance/lease'
import { GovernanceError } from '@/lib/governance/errors'
import { deviceSessionOpenSql } from '@/lib/device-presence'
import type { EnterpriseReader } from '@/lib/enterprise/principal'
import type { WorkspaceOpsMetricsView } from './device-policy-contract'

interface OpsMetricsSqlRow {
  onlineDevices: number
  boundDevices: number
  slackInstallations: number
  slackBindings: number
  telegramBindings: number
  activeBots: number
  artifactCount: number
  artifactVersions: number
  artifactBytes: string
  checkpointCount: number
  checkpointBytes: string
  queuedRuns: number
  runningRuns: number
  pendingPublications: number
  pendingScheduleOccurrences: number
  queuedSubagents: number
  runningSubagents: number
}

/**
 * Workspace-admin operational metrics read model (Frame 30).
 * Strictly tenant-scoped to `workspaceId` — never queries global `pg_database_size`
 * or leaks cross-tenant channels, storage or queue depth.
 */
export async function readWorkspaceOpsMetrics(
  reader: string | EnterpriseReader,
  workspaceId: string,
): Promise<WorkspaceOpsMetricsView> {
  z.uuid().parse(workspaceId)
  const userId = typeof reader === 'string' ? reader : reader.id
  return withTaskWorkspace(reader, workspaceId, () => writeTransaction(pool, async tx => {
    const scope = await readGovernanceLease(workspacePool, workspaceId, userId)
    if (scope.role !== 'admin') throw new GovernanceError('access_denied')
    const { rows: activeMemberRows } = await workspacePool.query<{ userId: string }>(
      `SELECT "userId" FROM mikka_workspace_members
       WHERE "workspaceId"=$1 AND status='active'`,
      [workspaceId],
    )
    const activeMembers = activeMemberRows.map(row => row.userId)
    const { rows: [metrics] } = await tx.query<OpsMetricsSqlRow>(
      `WITH bound_devices AS (
         SELECT DISTINCT d.id, ${deviceSessionOpenSql('d')} AS online
         FROM devices d
         WHERE d."removedAt" IS NULL
           AND (
             EXISTS (
               SELECT 1 FROM device_project_checkouts c
               WHERE c."workspaceId"=$1 AND c."deviceId"=d.id AND c."ownerId"=d."ownerId"
             )
             OR EXISTS (
               SELECT 1 FROM cloud_machines cm
               WHERE cm."workspaceId"=$1 AND cm."deviceId"=d.id AND cm."ownerId"=d."ownerId"
             )
             OR EXISTS (
               SELECT 1 FROM thread_machines tm
               WHERE tm."workspaceId"=$1 AND tm."deviceId"=d.id AND tm."ownerId"=d."ownerId"
                 AND tm.state <> 'ended'
             )
           )
       ),
       artifact_stats AS (
         SELECT
           count(DISTINCT a.id)::int AS "artifactCount",
           count(v.id)::int AS "artifactVersions",
           coalesce(sum(v.size), 0)::bigint::text AS "artifactBytes"
         FROM artifacts a
         LEFT JOIN artifact_versions v ON v."artifactId" = a.id
         WHERE a."workspaceId" = $1
       ),
       checkpoint_stats AS (
         SELECT
           count(c."runId")::int AS "checkpointCount",
           coalesce(sum(octet_length(c.patch)), 0)::bigint::text AS "checkpointBytes"
         FROM run_checkpoints c
         JOIN agent_runs r ON r.id = c."runId"
         WHERE r."workspaceId" = $1
       ),
       run_stats AS (
         SELECT
           count(*) FILTER (WHERE r.status = 'queued' AND r."stopRequestedAt" IS NULL)::int AS "queuedRuns",
           count(*) FILTER (WHERE r.status IN ('preparing','running','paused','waiting_input','finishing') AND r."stopRequestedAt" IS NULL)::int AS "runningRuns"
         FROM agent_runs r
         WHERE r."workspaceId" = $1
       ),
       publication_stats AS (
         SELECT count(*)::int AS "pendingPublications"
         FROM run_publications p
         JOIN agent_runs r ON r.id = p."runId"
         WHERE r."workspaceId" = $1
           AND p.status IN ('assigned','pending','processing','awaiting_approval')
       ),
       schedule_stats AS (
         SELECT count(*)::int AS "pendingScheduleOccurrences"
         FROM schedule_occurrences o
         JOIN user_schedules s ON s.id = o.schedule_id
         LEFT JOIN bots b ON b.id = s.bot_id
         WHERE coalesce(s.workspace_id, b."workspaceId") = $1
           AND o.status IN ('pending','running')
       ),
       subagent_stats AS (
         SELECT
           count(*) FILTER (WHERE status = 'queued')::int AS "queuedSubagents",
           count(*) FILTER (WHERE status IN ('running','needs_you'))::int AS "runningSubagents"
         FROM bot_subagents
         WHERE "workspaceId" = $1
       )
       SELECT
         (SELECT count(*) FILTER (WHERE online)::int FROM bound_devices) AS "onlineDevices",
         (SELECT count(*)::int FROM bound_devices) AS "boundDevices",
         (SELECT count(*)::int FROM mikka_slack_installations WHERE workspace_id=$1 AND revoking=false) AS "slackInstallations",
         (SELECT count(*)::int
            FROM mikka_slack_members m
            JOIN mikka_slack_installations i ON i.id = m.installation_id
           WHERE i.workspace_id=$1 AND i.revoking=false AND m.enabled=true
             AND m.user_id = ANY($2::text[])) AS "slackBindings",
         (SELECT count(*)::int
            FROM telegram_conversations tc
            JOIN issues i ON i.id = tc."issueId"
           WHERE i."workspaceId"=$1 AND i."ownershipState"='bound'
             AND tc."userId" = ANY($2::text[])) AS "telegramBindings",
         (SELECT count(*)::int FROM bots WHERE "workspaceId"=$1 AND "archivedAt" IS NULL) AS "activeBots",
         artifact_stats."artifactCount",
         artifact_stats."artifactVersions",
         artifact_stats."artifactBytes",
         checkpoint_stats."checkpointCount",
         checkpoint_stats."checkpointBytes",
         run_stats."queuedRuns",
         run_stats."runningRuns",
         publication_stats."pendingPublications",
         schedule_stats."pendingScheduleOccurrences",
         subagent_stats."queuedSubagents",
         subagent_stats."runningSubagents"
       FROM artifact_stats, checkpoint_stats, run_stats, publication_stats, schedule_stats, subagent_stats`,
      [workspaceId, activeMembers],
    )
    const artifactBytes = Number(metrics?.artifactBytes ?? '0')
    const checkpointBytes = Number(metrics?.checkpointBytes ?? '0')
    return {
      workspaceId,
      observedAt: new Date().toISOString(),
      channels: {
        onlineDevices: metrics?.onlineDevices ?? 0,
        boundDevices: metrics?.boundDevices ?? 0,
        slackInstallations: metrics?.slackInstallations ?? 0,
        slackBindings: metrics?.slackBindings ?? 0,
        telegramBindings: metrics?.telegramBindings ?? 0,
        activeBots: metrics?.activeBots ?? 0,
      },
      storage: {
        artifacts: {
          count: metrics?.artifactCount ?? 0,
          versions: metrics?.artifactVersions ?? 0,
          bytes: artifactBytes,
        },
        checkpoints: {
          count: metrics?.checkpointCount ?? 0,
          bytes: checkpointBytes,
        },
        totalBytes: artifactBytes + checkpointBytes,
      },
      queues: {
        queuedRuns: metrics?.queuedRuns ?? 0,
        runningRuns: metrics?.runningRuns ?? 0,
        pendingPublications: metrics?.pendingPublications ?? 0,
        pendingScheduleOccurrences: metrics?.pendingScheduleOccurrences ?? 0,
        queuedSubagents: metrics?.queuedSubagents ?? 0,
        runningSubagents: metrics?.runningSubagents ?? 0,
      },
    }
  }))
}
