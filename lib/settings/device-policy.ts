import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { pool } from '@/lib/db'
import { connectForCommitEffects } from '@/lib/db/commit-effects'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { ActionFailureError } from '@/lib/action-error'
import { deviceIsOnline } from '@/lib/device-presence'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import { ownerListChanged } from '@/lib/live/lists'
import { stopRunsForPolicyChange } from '@/lib/run-policy-stop'
import {
  DEVICE_MIGRATION_CAPABILITY,
  deleteDeviceRepositoryInput,
  patchDeviceRepositoryInput,
  updateDevicePolicyInput,
  upsertDeviceRepositoryInput,
  type DevicePolicyView,
  type DeviceRepositoryItem,
  type DeviceRepositoryListView,
} from './device-policy-contract'

export interface DevicePolicyActor {
  userId: string
  tokenWorkspaceId?: string | null
}

const LIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const
const RUNNING_AUTHORITY_STATUSES = ['preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const

interface LockedDevicePolicyRow {
  id: string
  ownerId: string
  enabled: boolean
  computerUseEnabled: boolean
  maxConcurrentRuns: number
  computerUse: { installed?: boolean; version?: string | null } | null
  sessionOpenedAt: Date | null
  sessionClosedAt: Date | null
  activeRuns: number
}

function parseDeviceUuid(deviceId: string): string {
  const parsed = z.uuid().safeParse(deviceId)
  if (!parsed.success) throw new ActionFailureError('deviceNotFound')
  return parsed.data
}

function parseOptionalWorkspaceId(workspaceId: string | undefined | null): string | undefined {
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') return undefined
  const parsed = z.uuid().safeParse(workspaceId)
  if (!parsed.success) throw new WorkspaceError('workspaceAccessDenied')
  return parsed.data
}

function toDevicePolicyView(row: LockedDevicePolicyRow): DevicePolicyView {
  const online = deviceIsOnline(row)
  const installed = Boolean(row.computerUse?.installed)
  const version = typeof row.computerUse?.version === 'string' ? row.computerUse.version : null
  return {
    deviceId: row.id,
    source: 'device',
    schedulingEnabled: row.enabled,
    computerUseEnabled: row.computerUseEnabled,
    scheduling: {
      enabled: row.enabled,
      maxConcurrentRuns: row.maxConcurrentRuns,
      activeRuns: row.activeRuns,
      availableSlots: row.enabled && online ? Math.max(0, row.maxConcurrentRuns - row.activeRuns) : 0,
    },
    computerUse: {
      enabled: row.computerUseEnabled,
      mode: row.computerUseEnabled ? 'allow' : 'deny',
      installed,
      version,
    },
    migration: DEVICE_MIGRATION_CAPABILITY,
  }
}

async function authorizeDevicePolicyAccess(
  actor: DevicePolicyActor,
  deviceOwnerId: string,
  deviceId: string,
  workspaceId: string | undefined,
  appClient: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
) {
  if (actor.tokenWorkspaceId && (!workspaceId || actor.tokenWorkspaceId !== workspaceId)) {
    throw new WorkspaceError('workspaceAccessDenied')
  }
  if (deviceOwnerId === actor.userId) {
    if (workspaceId) {
      await workspaceDb.transaction(ws => requireWorkspace(ws, workspaceId, actor.userId))
    }
    return
  }
  if (!workspaceId) throw new WorkspaceError('workspaceAccessDenied')
  await workspaceDb.transaction(async ws => {
    const { membership } = await requireWorkspace(ws, workspaceId, actor.userId)
    if (membership.role !== 'admin') throw new WorkspaceError('workspaceAccessDenied')
    const [ownerMembership] = await ws
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, deviceOwnerId),
        eq(workspaceMembers.status, 'active'),
      ))
      .for('share')
    if (!ownerMembership) throw new WorkspaceError('workspaceAccessDenied')
  })
  const binding = await appClient.query(
    `SELECT 1 FROM device_project_checkouts
       WHERE "deviceId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
     UNION ALL
     SELECT 1 FROM thread_machines
       WHERE "deviceId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
     UNION ALL
     SELECT 1 FROM cloud_machines
       WHERE "deviceId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
     LIMIT 1`,
    [deviceId, deviceOwnerId, workspaceId],
  )
  if (!binding.rowCount) throw new WorkspaceError('workspaceAccessDenied')
}

async function queryDevicePolicyRow(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  deviceId: string,
  lockMode: 'SHARE' | 'UPDATE',
): Promise<LockedDevicePolicyRow | null> {
  const { rows: [row] } = await client.query<LockedDevicePolicyRow>(
    `SELECT d.id, d."ownerId", d.enabled, d."computerUseEnabled", d."maxConcurrentRuns",
       d."computerUse", d."sessionOpenedAt", d."sessionClosedAt",
       (SELECT count(*)::int FROM agent_runs r
         WHERE r."deviceId"=d.id AND r."userId"=d."ownerId"
           AND r.status = ANY($2::text[])) AS "activeRuns"
     FROM devices d
     WHERE d.id=$1 AND d."removedAt" IS NULL
     FOR ${lockMode} OF d`,
    [deviceId, [...LIVE_RUN_STATUSES]],
  )
  return row ?? null
}

/**
 * Read scheduling participation, binary computer-use policy and honest cross-device
 * migration capability for a device. Accessible to the device owner or an active
 * workspace admin of a workspace to which this device is bound.
 */
export async function readDevicePolicy(
  actor: DevicePolicyActor,
  rawDeviceId: string,
  rawWorkspaceId?: string | null,
): Promise<DevicePolicyView> {
  const deviceId = parseDeviceUuid(rawDeviceId)
  const workspaceId = parseOptionalWorkspaceId(rawWorkspaceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const device = await queryDevicePolicyRow(client, deviceId, 'SHARE')
    if (!device) throw new ActionFailureError('deviceNotFound')
    await authorizeDevicePolicyAccess(actor, device.ownerId, deviceId, workspaceId, client)
    await client.query('COMMIT')
    return toDevicePolicyView(device)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Update `schedulingEnabled` (`devices.enabled`) and/or `computerUseEnabled`
 * (`devices.computerUseEnabled`). Binary allow/deny only — no `ask` tier.
 */
export async function writeDevicePolicy(
  actor: DevicePolicyActor,
  rawDeviceId: string,
  rawInput: unknown,
  queryWorkspaceId?: string | null,
): Promise<DevicePolicyView> {
  const deviceId = parseDeviceUuid(rawDeviceId)
  const parsed = updateDevicePolicyInput.parse(rawInput)
  const queryWs = parseOptionalWorkspaceId(queryWorkspaceId)
  if (parsed.workspaceId && queryWs && parsed.workspaceId !== queryWs) {
    throw new WorkspaceError('workspaceAccessDenied')
  }
  const workspaceId = parsed.workspaceId ?? queryWs
  const client = await connectForCommitEffects(pool)
  let updated: LockedDevicePolicyRow
  try {
    await client.query('BEGIN')
    const current = await queryDevicePolicyRow(client, deviceId, 'UPDATE')
    if (!current) throw new ActionFailureError('deviceNotFound')
    await authorizeDevicePolicyAccess(actor, current.ownerId, deviceId, workspaceId, client)
    const nextScheduling = parsed.schedulingEnabled ?? current.enabled
    const nextComputerUse = parsed.computerUseEnabled ?? current.computerUseEnabled
    await client.query(
      `UPDATE devices
       SET enabled=$2, "computerUseEnabled"=$3, "updatedAt"=now()
       WHERE id=$1`,
      [deviceId, nextScheduling, nextComputerUse],
    )
    if (current.computerUseEnabled && !nextComputerUse) {
      const active = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
         WHERE "deviceId"=$1 AND "userId"=$2 AND "stopRequestedAt" IS NULL
           AND status = ANY($3::text[])`,
        [deviceId, current.ownerId, [...RUNNING_AUTHORITY_STATUSES]],
      )
      if (active.rows.length) {
        await stopRunsForPolicyChange(client, { kind: 'runs', runIds: active.rows.map(row => row.id) })
      }
    }
    await ownerListChanged(client, current.ownerId, ['thread_list', 'device_list'])
    updated = (await queryDevicePolicyRow(client, deviceId, 'SHARE'))!
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  notifyDeviceWork(deviceId)
  return toDevicePolicyView(updated)
}

function normalizeRepositoryInput(raw: string) {
  const trimmed = raw.trim()
  const canonicalGithub = /^v2\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(trimmed)
  try {
    return normalizeRepository(canonicalGithub ? canonicalGithub[1]! : trimmed, {
      allowFile: daemonTestMode(process.env),
    })
  } catch (error) {
    throw new ActionFailureError('repoPathInvalid', undefined, undefined, { cause: error })
  }
}

interface DeviceRepoRow {
  id: string
  deviceId: string
  repoPath: string
  remoteUrl: string | null
  localPath: string | null
  baseBranch: string | null
  verifyCommand: string | null
  createdAt: Date
}

function toDeviceRepositoryItem(row: DeviceRepoRow): DeviceRepositoryItem {
  return {
    id: row.id,
    deviceId: row.deviceId,
    repoKey: row.repoPath,
    repoPath: row.repoPath,
    remoteUrl: row.remoteUrl,
    localPath: row.localPath,
    baseBranch: row.baseBranch,
    verifyCommand: row.verifyCommand,
    createdAt: row.createdAt.toISOString(),
  }
}

async function assertDeviceOwner(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  actor: DevicePolicyActor,
  deviceId: string,
  lockMode: 'SHARE' | 'UPDATE',
) {
  if (actor.tokenWorkspaceId) throw new WorkspaceError('workspaceAccessDenied')
  const { rows: [device] } = await client.query<{ id: string; ownerId: string }>(
    `SELECT id, "ownerId" FROM devices WHERE id=$1 AND "removedAt" IS NULL FOR ${lockMode}`,
    [deviceId],
  )
  if (!device) throw new ActionFailureError('deviceNotFound')
  if (device.ownerId !== actor.userId) throw new WorkspaceError('workspaceAccessDenied')
}

export async function listDeviceRepositories(
  actor: DevicePolicyActor,
  rawDeviceId: string,
): Promise<DeviceRepositoryListView> {
  const deviceId = parseDeviceUuid(rawDeviceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertDeviceOwner(client, actor, deviceId, 'SHARE')
    const { rows } = await client.query<DeviceRepoRow>(
      `SELECT id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"
       FROM device_repos
       WHERE "deviceId"=$1 AND "userId"=$2
       ORDER BY "repoPath", id`,
      [deviceId, actor.userId],
    )
    await client.query('COMMIT')
    return {
      deviceId,
      source: 'device',
      repositories: rows.map(toDeviceRepositoryItem),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function upsertDeviceRepository(
  actor: DevicePolicyActor,
  rawDeviceId: string,
  rawInput: unknown,
): Promise<DeviceRepositoryItem> {
  const deviceId = parseDeviceUuid(rawDeviceId)
  const parsed = upsertDeviceRepositoryInput.parse(rawInput)
  const repository = normalizeRepositoryInput((parsed.repository ?? parsed.repoKey)!)
  const client = await connectForCommitEffects(pool)
  try {
    await client.query('BEGIN')
    await assertDeviceOwner(client, actor, deviceId, 'UPDATE')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`device-repo:${deviceId}:${repository.key}`])
    const { rows: [existing] } = await client.query<DeviceRepoRow>(
      `SELECT id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"
       FROM device_repos
       WHERE "deviceId"=$1 AND "userId"=$2 AND "repoPath"=$3
       FOR UPDATE`,
      [deviceId, actor.userId, repository.key],
    )
    let saved: DeviceRepoRow
    if (existing) {
      const nextLocalPath = parsed.localPath === undefined ? existing.localPath : parsed.localPath
      const nextBaseBranch = parsed.baseBranch === undefined ? existing.baseBranch : parsed.baseBranch
      const nextVerifyCommand = parsed.verifyCommand === undefined ? existing.verifyCommand : parsed.verifyCommand
      const nextRemoteUrl = existing.remoteUrl ?? repository.remoteUrl
      const { rows: [row] } = await client.query<DeviceRepoRow>(
        `UPDATE device_repos
         SET "remoteUrl"=$4, "localPath"=$5, "baseBranch"=$6, "verifyCommand"=$7
         WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3
         RETURNING id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"`,
        [existing.id, deviceId, actor.userId, nextRemoteUrl, nextLocalPath, nextBaseBranch, nextVerifyCommand],
      )
      saved = row!
    } else {
      const { rows: [row] } = await client.query<DeviceRepoRow>(
        `INSERT INTO device_repos (id, "deviceId", "userId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"`,
        [
          crypto.randomUUID(),
          deviceId,
          actor.userId,
          repository.key,
          repository.remoteUrl,
          parsed.localPath ?? null,
          parsed.baseBranch === undefined ? 'main' : parsed.baseBranch,
          parsed.verifyCommand ?? null,
        ],
      )
      saved = row!
    }
    await ownerListChanged(client, actor.userId, ['device_list'])
    await client.query('COMMIT')
    return toDeviceRepositoryItem(saved)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function patchDeviceRepository(
  actor: DevicePolicyActor,
  rawDeviceId: string,
  rawInput: unknown,
): Promise<DeviceRepositoryItem> {
  const deviceId = parseDeviceUuid(rawDeviceId)
  const parsed = patchDeviceRepositoryInput.parse(rawInput)
  const lookupKey = parsed.id
    ? null
    : normalizeRepositoryInput((parsed.repository ?? parsed.repoKey)!).key
  const client = await connectForCommitEffects(pool)
  try {
    await client.query('BEGIN')
    await assertDeviceOwner(client, actor, deviceId, 'UPDATE')
    const { rows: [existing] } = parsed.id
      ? await client.query<DeviceRepoRow>(
          `SELECT id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"
           FROM device_repos
           WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3
           FOR UPDATE`,
          [parsed.id, deviceId, actor.userId],
        )
      : await client.query<DeviceRepoRow>(
          `SELECT id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"
           FROM device_repos
           WHERE "repoPath"=$1 AND "deviceId"=$2 AND "userId"=$3
           FOR UPDATE`,
          [lookupKey, deviceId, actor.userId],
        )
    if (!existing) throw new ActionFailureError('repoNotFound')
    const nextLocalPath = parsed.localPath === undefined ? existing.localPath : parsed.localPath
    const nextBaseBranch = parsed.baseBranch === undefined ? existing.baseBranch : parsed.baseBranch
    const nextVerifyCommand = parsed.verifyCommand === undefined ? existing.verifyCommand : parsed.verifyCommand
    const { rows: [updated] } = await client.query<DeviceRepoRow>(
      `UPDATE device_repos
       SET "localPath"=$4, "baseBranch"=$5, "verifyCommand"=$6
       WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3
       RETURNING id, "deviceId", "repoPath", "remoteUrl", "localPath", "baseBranch", "verifyCommand", "createdAt"`,
      [existing.id, deviceId, actor.userId, nextLocalPath, nextBaseBranch, nextVerifyCommand],
    )
    await ownerListChanged(client, actor.userId, ['device_list'])
    await client.query('COMMIT')
    return toDeviceRepositoryItem(updated!)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function deleteDeviceRepository(
  actor: DevicePolicyActor,
  rawDeviceId: string,
  rawInput: unknown,
): Promise<{ deleted: true; id: string; repoKey: string }> {
  const deviceId = parseDeviceUuid(rawDeviceId)
  const parsed = deleteDeviceRepositoryInput.parse(rawInput)
  const lookupKey = parsed.id ? null : normalizeRepositoryInput(parsed.repoKey!).key
  const client = await connectForCommitEffects(pool)
  try {
    await client.query('BEGIN')
    await assertDeviceOwner(client, actor, deviceId, 'UPDATE')
    const { rows: [existing] } = parsed.id
      ? await client.query<{ id: string; repoPath: string }>(
          `SELECT id, "repoPath" FROM device_repos
           WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3
           FOR UPDATE`,
          [parsed.id, deviceId, actor.userId],
        )
      : await client.query<{ id: string; repoPath: string }>(
          `SELECT id, "repoPath" FROM device_repos
           WHERE "repoPath"=$1 AND "deviceId"=$2 AND "userId"=$3
           FOR UPDATE`,
          [lookupKey, deviceId, actor.userId],
        )
    if (!existing) throw new ActionFailureError('repoNotFound')
    const activeRuns = await client.query(
      `SELECT 1 FROM agent_runs
       WHERE "deviceRepoId"=$1 AND status = ANY($2::text[])
       UNION ALL
       SELECT 1 FROM thread_machines
       WHERE "repoId"=$1 AND state <> 'ended'
       LIMIT 1`,
      [existing.id, [...LIVE_RUN_STATUSES]],
    )
    if (activeRuns.rowCount) throw new ActionFailureError('deviceHasActiveRuns')
    await client.query(`UPDATE thread_machines SET "repoId"=NULL WHERE "repoId"=$1 AND state='ended'`, [existing.id])
    await client.query(`DELETE FROM device_repos WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3`, [existing.id, deviceId, actor.userId])
    await ownerListChanged(client, actor.userId, ['device_list'])
    await client.query('COMMIT')
    return { deleted: true, id: existing.id, repoKey: existing.repoPath }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
