// Negative fixture for no-constant-stub-tests: legitimate unit test using local expected constants against real production logic.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWorkspaceCapabilities } from '@/lib/governance/capabilities'

const EXPECTED_PRO_IN_FLIGHT = 32
const EXPECTED_FREE_IN_FLIGHT = 8

let resolvedInFlightLimit = 0

beforeEach(() => {
  resolvedInFlightLimit = resolveWorkspaceCapabilities({
    kind: 'team',
    mode: 'cloud',
    plan: 'pro',
  }).hostedMaxInFlight
})

test('resolves pro workspace hosted concurrency from real governance capability contract', () => {
  const caps = resolveWorkspaceCapabilities({
    kind: 'team',
    mode: 'cloud',
    plan: 'pro',
  })
  assert.equal(caps.hostedMaxInFlight, EXPECTED_PRO_IN_FLIGHT)
  assert.equal(caps.isPaidPlan, true)
})

test('resolves free workspace hosted concurrency from real governance capability contract', () => {
  const caps = resolveWorkspaceCapabilities({
    kind: 'team',
    mode: 'cloud',
    plan: 'free',
  })
  assert.equal(caps.hostedMaxInFlight, EXPECTED_FREE_IN_FLIGHT)
  assert.equal(caps.isPaidPlan, false)
})

test('reads production result populated by beforeEach hook without false positive', () => {
  assert.equal(resolvedInFlightLimit, 32)
})
