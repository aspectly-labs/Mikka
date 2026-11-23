import test from 'node:test'
import assert from 'node:assert/strict'
import { LARGEST_DEFAULT_QUOTA_SIZE, MACHINE_SIZES, QUOTA_GATED_SIZES, provisionableMachineSize, type MachineSize } from './machine-pricing'
import { verifiedMachineQuota } from './sponsored-task'

test('quota-gated sizes sit above the provider default limit and are the only gated ones', () => {
  assert.equal(QUOTA_GATED_SIZES.has('standard-4-16'), true)
  assert.equal(QUOTA_GATED_SIZES.has('standard-4'), false)
  for (const size of QUOTA_GATED_SIZES) assert.ok(MACHINE_SIZES[size].gib > 12, `${size} exceeds the 12 GiB default account limit`)
  assert.equal(LARGEST_DEFAULT_QUOTA_SIZE, 'standard-4')
  assert.equal(MACHINE_SIZES[LARGEST_DEFAULT_QUOTA_SIZE].gib, 12)
})

test('an over-limit request maps to the largest default-quota size with its reason until quota is verified', () => {
  assert.deepEqual(provisionableMachineSize('standard-4-16', false),
    { requested: 'standard-4-16', size: 'standard-4', adjusted: 'provider_quota_unverified' })
  assert.deepEqual(provisionableMachineSize('standard-4-16', true),
    { requested: 'standard-4-16', size: 'standard-4-16', adjusted: null })
})

test('every size inside the default limit passes through whether or not quota is verified', () => {
  for (const size of Object.keys(MACHINE_SIZES) as MachineSize[]) {
    if (QUOTA_GATED_SIZES.has(size)) continue
    for (const verified of [false, true]) {
      assert.deepEqual(provisionableMachineSize(size, verified), { requested: size, size, adjusted: null }, size)
    }
  }
})

test('the verified-quota flag is opt-in and reads only its exact value', () => {
  assert.equal(verifiedMachineQuota({}), false)
  assert.equal(verifiedMachineQuota({ MIKKA_TASK_MACHINE_16GIB_QUOTA: '0' }), false)
  assert.equal(verifiedMachineQuota({ MIKKA_TASK_MACHINE_16GIB_QUOTA: 'true' }), false)
  assert.equal(verifiedMachineQuota({ MIKKA_TASK_MACHINE_16GIB_QUOTA: '1' }), true)
})
