import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEVICE_MIGRATION_CAPABILITY,
  deleteDeviceRepositoryInput,
  patchDeviceRepositoryInput,
  updateDevicePolicyInput,
  upsertDeviceRepositoryInput,
} from './device-policy-contract'
import { autoRechargeInputSchema } from '../billing/auto-recharge-schema'
import { desktopActionSchemas } from '../desktop-rpc/schemas'

const deviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('device policy schema accepts only binary booleans and rejects ask tier or forged actor fields', () => {
  assert.deepEqual(updateDevicePolicyInput.parse({ schedulingEnabled: false }), { schedulingEnabled: false })
  assert.deepEqual(updateDevicePolicyInput.parse({ computerUseEnabled: true, workspaceId }), {
    computerUseEnabled: true,
    workspaceId,
  })
  for (const invalid of [
    {},
    { computerUseEnabled: 'ask' },
    { computerUseEnabled: 'allow' },
    { schedulingEnabled: 'true' },
    { schedulingEnabled: true, ownerId: 'attacker' },
    { computerUseEnabled: false, workspaceId: 'not-a-uuid' },
  ]) {
    assert.equal(updateDevicePolicyInput.safeParse(invalid).success, false)
  }
  assert.equal(DEVICE_MIGRATION_CAPABILITY.available, false)
  assert.equal(DEVICE_MIGRATION_CAPABILITY.reason, 'machine_migration_not_supported')
  assert.deepEqual(DEVICE_MIGRATION_CAPABILITY.preserves, ['repository_checkpoint'])
})

test('device repository CRUD schemas enforce absolute paths, safe branch names and owner-free payloads', () => {
  assert.equal(upsertDeviceRepositoryInput.safeParse({
    repoKey: 'v2/github.com/aspectly-labs/mikka',
    localPath: '/Users/dev/work/mikka',
    baseBranch: 'main',
    verifyCommand: 'pnpm test:unit',
  }).success, true)
  assert.equal(upsertDeviceRepositoryInput.safeParse({
    repository: 'aspectly-labs/Mikka',
    localPath: null,
    baseBranch: null,
    verifyCommand: null,
  }).success, true)
  for (const invalid of [
    {},
    { repoKey: 'aspectly-labs/mikka', localPath: 'relative/path' },
    { repoKey: 'aspectly-labs/mikka', localPath: '/tmp/bad\0path' },
    { repoKey: 'aspectly-labs/mikka', baseBranch: 'bad..branch' },
    { repoKey: 'aspectly-labs/mikka', baseBranch: '-flag-injection' },
    { repoKey: 'aspectly-labs/mikka', verifyCommand: 'pnpm test\0bad' },
    { repoKey: 'aspectly-labs/mikka', userId: 'forged-owner' },
  ]) {
    assert.equal(upsertDeviceRepositoryInput.safeParse(invalid).success, false)
  }
  assert.equal(patchDeviceRepositoryInput.safeParse({ id: deviceId, baseBranch: 'release/1.0' }).success, true)
  assert.equal(patchDeviceRepositoryInput.safeParse({ id: deviceId }).success, false)
  assert.equal(deleteDeviceRepositoryInput.safeParse({ id: deviceId }).success, true)
  assert.equal(deleteDeviceRepositoryInput.safeParse({ repoKey: 'v2/github.com/acme/repo' }).success, true)
  assert.equal(deleteDeviceRepositoryInput.safeParse({}).success, false)
})

test('auto-recharge schema enforces discrete amount tiers, threshold < amount <= cap and consent when enabled', () => {
  assert.equal(autoRechargeInputSchema.safeParse({
    enabled: false,
    expectedRevision: 0,
    thresholdPoints: 250,
    amountPoints: 1000,
    monthlyCapPoints: 5000,
  }).success, true)
  assert.equal(autoRechargeInputSchema.safeParse({
    enabled: true,
    consent: true,
    expectedRevision: 1,
    thresholdPoints: 500,
    amountPoints: 2500,
    monthlyCapPoints: 2500,
  }).success, true)
  for (const invalid of [
    { enabled: true, consent: false, expectedRevision: 0, thresholdPoints: 100, amountPoints: 1000, monthlyCapPoints: 2000 },
    { enabled: false, expectedRevision: 0, thresholdPoints: 1000, amountPoints: 1000, monthlyCapPoints: 2000 },
    { enabled: false, expectedRevision: 0, thresholdPoints: 100, amountPoints: 1500, monthlyCapPoints: 2000 },
    { enabled: false, expectedRevision: 0, thresholdPoints: 100, amountPoints: 2500, monthlyCapPoints: 1000 },
    { enabled: false, expectedRevision: 0, thresholdPoints: 100, amountPoints: 1000, monthlyCapPoints: 2000, workspaceId },
  ]) {
    assert.equal(autoRechargeInputSchema.safeParse(invalid).success, false)
  }
})

test('Desktop RPC schemas register WS-G actions and reject forged authority arguments', () => {
  assert.equal(desktopActionSchemas['devices.getPolicy'].safeParse([deviceId, workspaceId]).success, true)
  assert.equal(desktopActionSchemas['devices.updatePolicy'].safeParse([deviceId, { computerUseEnabled: false }, workspaceId]).success, true)
  assert.equal(desktopActionSchemas['devices.updatePolicy'].safeParse([deviceId, { computerUseEnabled: 'ask' }]).success, false)
  assert.equal(desktopActionSchemas['devices.listRepositories'].safeParse([deviceId]).success, true)
  assert.equal(desktopActionSchemas['devices.upsertRepository'].safeParse([deviceId, { repository: 'acme/app' }]).success, true)
  assert.equal(desktopActionSchemas['devices.deleteRepository'].safeParse([deviceId, { id: workspaceId }]).success, true)
  assert.equal(desktopActionSchemas['billing.getBillingSettings'].safeParse([workspaceId]).success, true)
  assert.equal(desktopActionSchemas['billing.saveAutoRechargePolicy'].safeParse([{
    enabled: false,
    expectedRevision: 0,
    thresholdPoints: 100,
    amountPoints: 1000,
    monthlyCapPoints: 3000,
  }, workspaceId]).success, true)
  assert.equal(desktopActionSchemas['ops-metrics.getWorkspaceOpsMetrics'].safeParse([workspaceId]).success, true)
  assert.equal(desktopActionSchemas['ops-metrics.getWorkspaceOpsMetrics'].safeParse([workspaceId, { role: 'admin' }]).success, false)
})
