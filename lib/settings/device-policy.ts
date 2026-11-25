import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { daemonTestMode, normalizeRepository, remoteKey } from '@mikka/protocol/repository'
import { pool } from '@/lib/db'
import { connectForCommitEffects } from '@/lib/db/commit-effects'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import type { EnterprisePrincipal } from '@/lib/enterprise/principal'
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
  type DeviceRepositorySetupInput,
} from './device-policy-contract'

export interface DevicePolicyActor {
  userId: string
  tokenWorkspaceId?: string | null
  principal?: EnterprisePrincipal
}

type WorkspaceTx = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
interface WorkspacePolicyScope {
  ws: WorkspaceTx
  workspaceId: string
  role: 'admin' | 'member'
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

/**
 * Match Mikka's repo-wide WS -> APP lock order: when `workspaceId` is present,
 * open the outer `workspaceDb` transaction and verify membership + enterprise
 * principal before taking any `devices` lock on `pool`.
 */
async function withDevicePolicyWorkspaceScope<T>(
  actor: DevicePolicyActor,
  workspaceId: string | undefined,
  work: (scope: WorkspacePolicyScope | null) => Promise<T>,
): Promise<T> {
  if (actor.tokenWorkspaceId && (!workspaceId || actor.tokenWorkspaceId !== workspaceId)) {
    throw new WorkspaceError('workspaceAccessDenied')
  }
  if (!workspaceId) return work(null)
  return workspaceDb.transaction(async ws => {
    const { membership } = await requireWorkspace(ws, workspaceId, actor.userId, false, actor.principal)
    return work({ ws, workspaceId, role: membership.role as 'admin' | 'member' })
  })
}

async function assertLockedDevicePolicyAccess(
  actor: DevicePolicyActor,
  deviceOwnerId: string,
  deviceId: string,
  scope: WorkspacePolicyScope | null,
  appClient: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
) {
  if (deviceOwnerId === actor.userId) return
  if (!scope || scope.role !== 'admin') throw new WorkspaceError('workspaceAccessDenied')
  const [ownerMembership] = await scope.ws
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, scope.workspaceId),
      eq(workspaceMembers.userId, deviceOwnerId),
      eq(workspaceMembers.status, 'active'),
    ))
    .for('share')
  if (!ownerMembership) throw new WorkspaceError('workspaceAccessDenied')
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
    [deviceId, deviceOwnerId, scope.workspaceId],
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
  return withDevicePolicyWorkspaceScope(actor, workspaceId, async scope => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const device = await queryDevicePolicyRow(client, deviceId, 'SHARE')
      if (!device) throw new ActionFailureError('deviceNotFound')
      await assertLockedDevicePolicyAccess(actor, device.ownerId, deviceId, scope, client)
      await client.query('COMMIT')
      return toDevicePolicyView(device)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
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
  const updated = await withDevicePolicyWorkspaceScope(actor, workspaceId, async scope => {
    const client = await connectForCommitEffects(pool)
    try {
      await client.query('BEGIN')
      const current = await queryDevicePolicyRow(client, deviceId, 'UPDATE')
      if (!current) throw new ActionFailureError('deviceNotFound')
      await assertLockedDevicePolicyAccess(actor, current.ownerId, deviceId, scope, client)
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
      const row = (await queryDevicePolicyRow(client, deviceId, 'SHARE'))!
      await client.query('COMMIT')
      return row
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
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

interface StoredSetupRecipe {
  command?: string
  copyFiles?: string[]
  approved?: boolean
}

interface DeviceRepoRow {
  id: string
  deviceId: string
  repoPath: string
  remoteUrl: string | null
  localPath: string | null
  baseBranch: string | null
  verifyCommand: string | null
  setup?: StoredSetupRecipe | null
  createdAt: Date
}

function toDeviceRepositorySetup(raw: StoredSetupRecipe | null | undefined): DeviceRepositoryItem['setup'] {
  if (!raw || typeof raw !== 'object') return null
  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command : null
  const copyFiles = Array.isArray(raw.copyFiles) ? raw.copyFiles.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  if (!command && copyFiles.length === 0) return null
  return { command, copyFiles, approved: raw.approved === true }
}

function normalizeSetupForStorage(input: DeviceRepositorySetupInput | null): { copyFiles: string[]; command?: string; approved: boolean } | null {
  if (!input) return null
  const command = input.command?.trim() || undefined
  const copyFiles = [...new Set(input.copyFiles)]
  if (!command && copyFiles.length === 0) return null
  return { copyFiles, ...(command ? { command } : {}), approved: input.approved }
}

function resolveRepositorySetupKey(repoPath: string, remoteUrl: string | null): string {
  if (remoteUrl) {
    try {
      return remoteKey(remoteUrl)
    } catch {
      // Fall back to canonical repoPath when remoteUrl cannot be parsed.
    }
  }
  return repoPath
}

async function persistRepositorySetup(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
  remoteKey: string,
  setupInput: DeviceRepositorySetupInput | null,
): Promise<StoredSetupRecipe | null> {
  const stored = normalizeSetupForStorage(setupInput)
  if (!stored) {
    await client.query(
      `UPDATE repository_settings SET setup=NULL, "updatedAt"=now() WHERE "userId"=$1 AND "remoteKey"=$2`,
      [userId, remoteKey],
    )
    return null
  }
  await client.query(
    `INSERT INTO repository_settings ("userId", "remoteKey", setup, "updatedAt")
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT ("userId", "remoteKey")
     DO UPDATE SET setup=excluded.setup, "updatedAt"=now()`,
    [userId, remoteKey, JSON.stringify(stored)],
  )
  return stored
}

async function readRepositorySetup(
  client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
  remoteKey: string,
): Promise<StoredSetupRecipe | null> {
  const { rows: [row] } = await client.query<{ setup: StoredSetupRecipe | null }>(
    `SELECT setup FROM repository_settings WHERE "userId"=$1 AND "remoteKey"=$2 LIMIT 1`,
    [userId, remoteKey],
  )
  return row?.setup ?? null
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
    setup: toDeviceRepositorySetup(row.setup),
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
      `SELECT dr.id, dr."deviceId", dr."repoPath", dr."remoteUrl", dr."localPath", dr."baseBranch", dr."verifyCommand", rs.setup, dr."createdAt"
       FROM device_repos dr
       LEFT JOIN repository_settings rs ON rs."userId" = dr."userId" AND rs."remoteKey" = dr."repoPath"
       WHERE dr."deviceId"=$1 AND dr."userId"=$2
       ORDER BY dr."repoPath", dr.id`,
      [deviceId, actor.userId],
    )
    const fallbackKeys = [...new Set(
      rows
        .filter((row) => !row.setup && row.remoteUrl)
        .map((row) => ({ row, key: resolveRepositorySetupKey(row.repoPath, row.remoteUrl) }))
        .filter(({ row, key }) => key !== row.repoPath)
        .map(({ key }) => key),
    )]
    const fallbackByKey = new Map<string, StoredSetupRecipe | null>()
    if (fallbackKeys.length > 0) {
      const { rows: fallbackRows } = await client.query<{ remoteKey: string; setup: StoredSetupRecipe | null }>(
        `SELECT "remoteKey", setup FROM repository_settings WHERE "userId"=$1 AND "remoteKey" = ANY($2::text[])`,
        [actor.userId, fallbackKeys],
      )
      for (const fallbackRow of fallbackRows) {
        fallbackByKey.set(fallbackRow.remoteKey, fallbackRow.setup)
      }
    }
    await client.query('COMMIT')
    return {
      deviceId,
      source: 'device',
      repositories: rows.map((row) => {
        if (row.setup) return toDeviceRepositoryItem(row)
        const key = resolveRepositorySetupKey(row.repoPath, row.remoteUrl)
        return toDeviceRepositoryItem({ ...row, setup: fallbackByKey.get(key) ?? null })
      }),
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
    const setupKey = resolveRepositorySetupKey(saved.repoPath, saved.remoteUrl)
    const nextSetup = parsed.setup !== undefined
      ? await persistRepositorySetup(client, actor.userId, setupKey, parsed.setup)
      : await readRepositorySetup(client, actor.userId, setupKey)
    await ownerListChanged(client, actor.userId, ['device_list'])
    await client.query('COMMIT')
    return toDeviceRepositoryItem({ ...saved, setup: nextSetup })
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
    const setupKey = resolveRepositorySetupKey(updated!.repoPath, updated!.remoteUrl)
    const nextSetup = parsed.setup !== undefined
      ? await persistRepositorySetup(client, actor.userId, setupKey, parsed.setup)
      : await readRepositorySetup(client, actor.userId, setupKey)
    await ownerListChanged(client, actor.userId, ['device_list'])
    await client.query('COMMIT')
    return toDeviceRepositoryItem({ ...updated!, setup: nextSetup })
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
