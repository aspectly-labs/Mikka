import test from 'node:test'
import assert from 'node:assert/strict'
import { PaidResourceError } from '@/lib/abuse/policy'
import { DEFAULT_MACHINE_SIZE, MACHINE_CHUNK_MS, machineChunkMicroUsd, machineHourlyUsd, machineSkuListPrice, machineSkuGeometry, machinePriceIsEffective, machineLedgerLabel, prepaidMachineMicroUsd, machineListUsageMicroUsd, MACHINE_LIST_PRICE_START } from './machine-pricing'
import { fundMachineChunk, machineChunkId, type MachineBillingDependencies, type MachineChunk } from './machine-billing'

test('machines are priced by memory at USD 0.025 per GiB-hour; standard-3 is the default', () => {
  assert.deepEqual(['standard-1', 'standard-2', 'standard-3', 'standard-4', 'standard-4-16'].map(size => machineHourlyUsd(size as never)), [0.1, 0.15, 0.2, 0.3, 0.4])
  assert.equal(DEFAULT_MACHINE_SIZE, 'standard-3')
  // A five-minute chunk of standard-3: USD 0.2 / 12.
  assert.equal(MACHINE_CHUNK_MS, 300_000)
  assert.equal(machineChunkMicroUsd('standard-3'), 16_667)
})

const chunk: MachineChunk = { provider: 'cloudflare', ownerId: 'owner', workspaceId: 'workspace', runId: 'run', operationId: 'op', index: 2, size: 'standard-3' }

function fake(states: Map<string, string>, charge: MachineBillingDependencies['charge']): MachineBillingDependencies & { charged: number[] } {
  const charged: number[] = []
  return { charged, state: async id => states.get(id) ?? null, charge: async (c, id, cost) => { await charge(c, id, cost); charged.push(cost); states.set(id, 'settled') } }
}

test('a chunk is charged once at its prepaid price; a retried renewal never charges twice', async () => {
  const states = new Map<string, string>()
  const deps = fake(states, async () => {})
  assert.equal(await fundMachineChunk(chunk, deps), true)
  assert.equal(await fundMachineChunk(chunk, deps), true)
  assert.deepEqual(deps.charged, [16_667])
  assert.equal(machineChunkId(chunk), 'machine:run:op:2')
})

test('a Cloudflare receipt for another size cannot admit this allocation', async () => {
  const deps = fake(new Map([[machineChunkId(chunk), 'different_sku']]), async () => assert.fail('another size already owns the receipt'))
  assert.equal(await fundMachineChunk(chunk, deps), false)
})

test('nothing to pay with: unfunded, not an error', async () => {
  for (const code of ['points_exhausted', 'verification_required', 'usage_budget_exhausted'] as const) {
    const deps = fake(new Map(), async () => { throw new PaidResourceError(code) })
    assert.equal(await fundMachineChunk(chunk, deps), false, code)
  }
})

test('a concurrent charge of the same chunk counts only once it settled; other failures keep their cause', async () => {
  const states = new Map<string, string>([[machineChunkId(chunk), 'pending']])
  const busy = fake(states, async () => { throw new PaidResourceError('usage_in_progress') })
  assert.equal(await fundMachineChunk(chunk, busy), false)
  states.set(machineChunkId(chunk), 'settled')
  assert.equal(await fundMachineChunk(chunk, busy), true)
  const broken = fake(new Map(), async () => { throw new TypeError('database down') })
  await assert.rejects(fundMachineChunk(chunk, broken), (error: Error) => error.message === 'machine_chunk_charge_failed' && error.cause instanceof TypeError)
})

test('provider quotes use effective dates, exact resource prices and five-minute fixed-point rounding', () => {
  const start = Date.parse(MACHINE_LIST_PRICE_START)
  assert.equal(machineSkuListPrice({ provider: 'e2b', size: 'medium' }, start - 1), null)
  const e2b = machineSkuListPrice({ provider: 'e2b', size: 'medium' }, start)
  assert.deepEqual(e2b, { version: '2026-11-26', effectiveFrom: MACHINE_LIST_PRICE_START, effectiveUntil: null,
    minimumPrepaidSeconds: 300, basis: 'provisioned_hour', hourlyMicroUsd: 230_400 })
  const bounded = { effectiveFrom: MACHINE_LIST_PRICE_START, effectiveUntil: '2026-12-01T00:00:00.000Z' }
  assert.equal(machinePriceIsEffective(bounded, Date.parse(bounded.effectiveUntil) - 1), true)
  assert.equal(machinePriceIsEffective(bounded, Date.parse(bounded.effectiveUntil)), false)
  assert.equal(machinePriceIsEffective(bounded, Number.NaN), false)
  const cloudflare = { provider: 'cloudflare', size: 'standard-3' } as const
  assert.deepEqual(machineSkuGeometry(cloudflare), { vcpu: 2, ramGib: 8 })
  assert.deepEqual(machineSkuGeometry({ provider: 'e2b', size: 'medium' }), { vcpu: 2, ramGib: 8 })
  assert.deepEqual(machineSkuListPrice(cloudflare, start), { version: '2026-11-26', effectiveFrom: MACHINE_LIST_PRICE_START,
    effectiveUntil: null, minimumPrepaidSeconds: 300, basis: 'active_cpu', fixedHourlyMicroUsd: 76_032,
    activeVcpuHourlyMicroUsd: 72_000 })
  const cfRate = machineSkuListPrice(cloudflare, start)!
  assert.equal(machineListUsageMicroUsd(cfRate, 3_600_000), null, 'provisioned vCPU is not evidence of active CPU')
  assert.equal(machineListUsageMicroUsd(cfRate, 3_600_000, 0), 76_032)
  assert.equal(machineListUsageMicroUsd(cfRate, 3_600_000, 1_800_000), 112_032)
  assert.equal(machineListUsageMicroUsd(e2b!, 1_000), 64)
  assert.equal(machineListUsageMicroUsd(e2b!, 1_001), 65)
  assert.equal(machineSkuListPrice({ provider: 'cloudflare', size: 'standard-4-16' }, start), null)
  assert.equal(prepaidMachineMicroUsd(230_400), 19_200)
  assert.equal(prepaidMachineMicroUsd(230_401), 19_201)
  assert.equal(machineLedgerLabel(cloudflare), 'machine/cloudflare-standard-3')
  assert.equal(machineLedgerLabel({ provider: 'e2b', size: 'medium' }), 'machine/e2b-medium')
  assert.equal(machineChunkId({ provider: 'e2b', runId: 'run', operationId: 'op', index: 2 }), 'machine:e2b:op:2')
})
