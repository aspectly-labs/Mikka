'use server'

import { withFreshSession } from '@/lib/fresh-session'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/issue-access'
import { workspaceAction } from '@/lib/workspace-admin/action'
import {
  deleteDeviceRepository,
  listDeviceRepositories,
  patchDeviceRepository,
  readDevicePolicy,
  upsertDeviceRepository,
  writeDevicePolicy,
} from '@/lib/settings/device-policy'
import type {
  DeleteDeviceRepositoryInput,
  DevicePolicyView,
  DeviceRepositoryItem,
  DeviceRepositoryListView,
  PatchDeviceRepositoryInput,
  UpdateDevicePolicyInput,
  UpsertDeviceRepositoryInput,
} from '@/lib/settings/device-policy-contract'

export async function getPolicy(deviceId: string, workspaceId?: string): Promise<ActionResult<DevicePolicyView>> {
  return workspaceAction(async () => {
    const user = await requireUser()
    return readDevicePolicy({ userId: user.id }, deviceId, workspaceId)
  })
}

async function updatePolicyBody(
  deviceId: string,
  input: UpdateDevicePolicyInput,
  workspaceId?: string,
): Promise<ActionResult<DevicePolicyView>> {
  return workspaceAction(async () => {
    const user = await requireUser()
    return writeDevicePolicy({ userId: user.id }, deviceId, input, workspaceId)
  })
}

export async function listRepositories(deviceId: string): Promise<ActionResult<DeviceRepositoryListView>> {
  return workspaceAction(async () => {
    const user = await requireUser()
    return listDeviceRepositories({ userId: user.id }, deviceId)
  })
}

async function upsertRepositoryBody(
  deviceId: string,
  input: UpsertDeviceRepositoryInput,
): Promise<ActionResult<DeviceRepositoryItem>> {
  return workspaceAction(async () => {
    const user = await requireUser()
    return upsertDeviceRepository({ userId: user.id }, deviceId, input)
  })
}

async function patchRepositoryBody(
  deviceId: string,
  input: PatchDeviceRepositoryInput,
): Promise<ActionResult<DeviceRepositoryItem>> {
  return workspaceAction(async () => {
    const user = await requireUser()
    return patchDeviceRepository({ userId: user.id }, deviceId, input)
  })
}

async function deleteRepositoryBody(
  deviceId: string,
  input: DeleteDeviceRepositoryInput,
): Promise<ActionResult<{ deleted: true; id: string; repoKey: string }>> {
  return workspaceAction(async () => {
    const user = await requireUser()
    return deleteDeviceRepository({ userId: user.id }, deviceId, input)
  })
}

export async function updatePolicy(...args: Parameters<typeof updatePolicyBody>) {
  return withFreshSession(() => updatePolicyBody(...args))
}
export async function upsertRepository(...args: Parameters<typeof upsertRepositoryBody>) {
  return withFreshSession(() => upsertRepositoryBody(...args))
}
export async function patchRepository(...args: Parameters<typeof patchRepositoryBody>) {
  return withFreshSession(() => patchRepositoryBody(...args))
}
export async function deleteRepository(...args: Parameters<typeof deleteRepositoryBody>) {
  return withFreshSession(() => deleteRepositoryBody(...args))
}
