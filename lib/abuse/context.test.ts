import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedDecisionGate, decisionBatchCache, forgetDecisionGate, DECISION_GATE_TTL_MS } from './context'

test('cachedDecisionGate loads once per batch and shares the value', async () => {
  let loads = 0
  const load = async () => ++loads
  const seen = await decisionBatchCache.run(new Map(), async () => {
    const first = await cachedDecisionGate('k', load)
    const second = await cachedDecisionGate('k', load)
    return [first, second]
  })
  assert.deepEqual(seen, [1, 1])
  assert.equal(loads, 1)
})

test('outside a batch every call loads, and batches do not leak into each other', async () => {
  let loads = 0
  const load = async () => ++loads
  assert.equal(await cachedDecisionGate('k', load), 1)
  assert.equal(await cachedDecisionGate('k', load), 2)
  await decisionBatchCache.run(new Map(), () => cachedDecisionGate('k', load))
  await decisionBatchCache.run(new Map(), () => cachedDecisionGate('k', load))
  assert.equal(loads, 4)
})

test('a rejected load is evicted so the next call in the batch retries', async () => {
  let loads = 0
  const result = await decisionBatchCache.run(new Map(), async () => {
    await assert.rejects(cachedDecisionGate('k', async () => { loads++; throw new Error('first') }), /first/)
    return cachedDecisionGate('k', async () => { loads++; return 'ok' })
  })
  assert.equal(result, 'ok')
  assert.equal(loads, 2)
})

test('forgetDecisionGate drops the entry inside the batch and is a no-op outside', async () => {
  let loads = 0
  const load = async () => ++loads
  forgetDecisionGate('k')
  const seen = await decisionBatchCache.run(new Map(), async () => {
    await cachedDecisionGate('k', load)
    forgetDecisionGate('k')
    return cachedDecisionGate('k', load)
  })
  assert.equal(seen, 2)
  assert.equal(loads, 2)
})

test('an entry older than the TTL is reloaded inside the same batch', async t => {
  let loads = 0
  let now = 1_000
  const load = async () => ++loads
  t.mock.method(Date, 'now', () => now)
  const seen = await decisionBatchCache.run(new Map(), async () => {
    await cachedDecisionGate('k', load)
    now += DECISION_GATE_TTL_MS + 1
    return cachedDecisionGate('k', load)
  })
  assert.equal(seen, 2)
  assert.equal(loads, 2)
})
