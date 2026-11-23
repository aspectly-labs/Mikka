import { z } from 'zod'

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Shared WS-G contracts for device policy, repository scope CRUD and
 * workspace ops metrics. Kept in its own file to avoid colliding with P2
 * (#2968) and P8 (#2962) while aligning field shapes with DeviceSettingsDetail.
 */

export interface DeviceMigrationPolicyCapability {
  available: false
  reason: 'machine_migration_not_supported'
  preserves: ['repository_checkpoint']
  excludes: ['process_memory', 'native_session', 'ignored_files', 'credentials']
}

export const DEVICE_MIGRATION_CAPABILITY: DeviceMigrationPolicyCapability = {
  available: false,
  reason: 'machine_migration_not_supported',
  preserves: ['repository_checkpoint'],
  excludes: ['process_memory', 'native_session', 'ignored_files', 'credentials'],
}

export interface DevicePolicyView {
  deviceId: string
  source: 'device'
  schedulingEnabled: boolean
  computerUseEnabled: boolean
  scheduling: {
    enabled: boolean
    maxConcurrentRuns: number
    activeRuns: number
    availableSlots: number
  }
  computerUse: {
    enabled: boolean
    mode: 'allow' | 'deny'
    installed: boolean
    version: string | null
  }
  migration: DeviceMigrationPolicyCapability
}

export const updateDevicePolicyInput = z.object({
  schedulingEnabled: z.boolean().optional(),
  computerUseEnabled: z.boolean().optional(),
  workspaceId: z.uuid().optional(),
}).strict().refine(
  value => value.schedulingEnabled !== undefined || value.computerUseEnabled !== undefined,
  { message: 'At least one policy field must be provided.' },
)

export type UpdateDevicePolicyInput = z.infer<typeof updateDevicePolicyInput>

const safeLocalPath = z.string().trim().min(1).max(1024).refine(
  value => !Array.from(value).some(char => char.charCodeAt(0) < 32)
    && isAbsoluteLocalPath(value),
  { message: 'Local path must be an absolute filesystem path without control characters.' },
)

const safeBaseBranch = z.string().trim().min(1).max(255).refine(
  value => !Array.from(value).some(char => {
    const code = char.charCodeAt(0)
    return code <= 32 || code === 127
  }) && !/[~^:?*[\\]/.test(value)
    && !value.includes('..') && !value.startsWith('-') && !value.endsWith('.') && !value.endsWith('.lock'),
  { message: 'Invalid Git branch name.' },
)

const safeVerifyCommand = z.string().trim().min(1).max(2000).refine(
  value => !value.includes('\0'),
  { message: 'Invalid verify command.' },
)

export const upsertDeviceRepositoryInput = z.object({
  repoKey: z.string().trim().min(1).max(4000).optional(),
  repository: z.string().trim().min(1).max(4000).optional(),
  localPath: safeLocalPath.nullable().optional(),
  baseBranch: safeBaseBranch.nullable().optional(),
  verifyCommand: safeVerifyCommand.nullable().optional(),
}).strict().refine(
  value => Boolean(value.repoKey ?? value.repository),
  { message: 'repoKey or repository is required.' },
)

export type UpsertDeviceRepositoryInput = z.infer<typeof upsertDeviceRepositoryInput>

export const patchDeviceRepositoryInput = z.object({
  id: z.uuid().optional(),
  repoKey: z.string().trim().min(1).max(4000).optional(),
  repository: z.string().trim().min(1).max(4000).optional(),
  localPath: safeLocalPath.nullable().optional(),
  baseBranch: safeBaseBranch.nullable().optional(),
  verifyCommand: safeVerifyCommand.nullable().optional(),
}).strict().refine(
  value => Boolean(value.id ?? value.repoKey ?? value.repository),
  { message: 'id, repoKey or repository is required.' },
).refine(
  value => value.localPath !== undefined || value.baseBranch !== undefined || value.verifyCommand !== undefined,
  { message: 'At least one mutable repository field is required.' },
)

export type PatchDeviceRepositoryInput = z.infer<typeof patchDeviceRepositoryInput>

export const deleteDeviceRepositoryInput = z.object({
  id: z.uuid().optional(),
  repoKey: z.string().trim().min(1).max(4000).optional(),
}).strict().refine(
  value => Boolean(value.id ?? value.repoKey),
  { message: 'id or repoKey is required.' },
)

export type DeleteDeviceRepositoryInput = z.infer<typeof deleteDeviceRepositoryInput>

export interface DeviceRepositoryItem {
  id: string
  deviceId: string
  repoKey: string
  repoPath: string
  remoteUrl: string | null
  localPath: string | null
  baseBranch: string | null
  verifyCommand: string | null
  createdAt: string
}

export interface DeviceRepositoryListView {
  deviceId: string
  source: 'device'
  repositories: DeviceRepositoryItem[]
}

export interface WorkspaceOpsMetricsView {
  workspaceId: string
  observedAt: string
  channels: {
    onlineDevices: number
    boundDevices: number
    slackInstallations: number
    slackBindings: number
    telegramBindings: number
    activeBots: number
  }
  storage: {
    artifacts: {
      count: number
      versions: number
      bytes: number
    }
    checkpoints: {
      count: number
      bytes: number
    }
    totalBytes: number
  }
  queues: {
    queuedRuns: number
    runningRuns: number
    pendingPublications: number
    pendingScheduleOccurrences: number
    queuedSubagents: number
    runningSubagents: number
  }
}
