import assert from 'node:assert/strict'
import test from 'node:test'
import { overageInputSchema } from './overage-schema'

test('overage input schema enforces finite non-negative revisions and optional nullable cap', () => {
  assert.deepEqual(
    overageInputSchema.parse({ enabled: false, monthlyCapPoints: null, expectedRevision: 0 }),
    { enabled: false, monthlyCapPoints: null, expectedRevision: 0 },
  )
  assert.deepEqual(
    overageInputSchema.parse({ enabled: true, monthlyCapPoints: 2500, expectedRevision: 1 }),
    { enabled: true, monthlyCapPoints: 2500, expectedRevision: 1 },
  )
  assert.throws(() => overageInputSchema.parse({ enabled: false, monthlyCapPoints: -1, expectedRevision: 0 }))
  assert.throws(() => overageInputSchema.parse({ enabled: true, monthlyCapPoints: 2500, expectedRevision: -1 }))
  assert.throws(() => overageInputSchema.parse({ enabled: true, monthlyCapPoints: 2500, expectedRevision: 0, extra: true }))
})
