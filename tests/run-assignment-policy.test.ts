import assert from 'node:assert/strict'
import test from 'node:test'
import { readOnlyRunPolicy, defaultRunPolicy, runPolicyDigestInput } from '@mikka/protocol/agent-policy'
import { constrainedAssignmentPolicy, intersectRunPolicy } from '../lib/run-assignment-policy'

test('frozen checks preserve their exact evidence policy under the current ceiling', () => {
  const current = defaultRunPolicy()
  const frozen = readOnlyRunPolicy({ ...current, networkAllow: [] })
  assert.equal(constrainedAssignmentPolicy(current, undefined), current)
  assert.equal(runPolicyDigestInput(constrainedAssignmentPolicy(current, frozen)), runPolicyDigestInput(frozen))
})

test('a frozen check cannot remove a read-only role, and a malformed one is refused', () => {
  const frozen = readOnlyRunPolicy(defaultRunPolicy())
  assert.throws(() => constrainedAssignmentPolicy(frozen, defaultRunPolicy()), /exceeds/)
  assert.throws(() => constrainedAssignmentPolicy(defaultRunPolicy(), { permissions: {} }))
})

test('a frozen check from an older build with a domain list still runs (ADR 2026-11-27-1615)', () => {
  const current = { ...defaultRunPolicy(), networkAllow: [] }
  const frozen = readOnlyRunPolicy({ ...defaultRunPolicy(), networkAllow: ['github.com'] })
  assert.deepEqual(constrainedAssignmentPolicy(current, frozen), frozen)
})

test('provider continuation keeps the read-only role, the host push flag and the computer grant', () => {
  const broad = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, git_push: 'allow' as const, computer_use: 'allow' as const } }
  const ceiling = readOnlyRunPolicy({ ...defaultRunPolicy(), networkCeiling: ['api.example.invalid'],
    permissions: { ...defaultRunPolicy().permissions, git_push: 'deny' as const, computer_use: 'deny' as const } })
  const before = structuredClone({ broad, ceiling })
  const effective = intersectRunPolicy(broad, ceiling)
  assert.equal(effective.readOnly, true)
  assert.equal(effective.permissions.install_dependency, 'deny')
  assert.equal(effective.permissions.write_outside_repo, 'deny')
  assert.equal(effective.permissions.git_push, 'deny')
  assert.equal(effective.permissions.computer_use, 'deny')
  assert.equal(effective.permissions.network, 'allow')
  assert.equal(effective.networkCeiling, undefined, 'a stored network ceiling restricts nothing')
  assert.deepEqual({ broad, ceiling }, before, 'composition does not mutate either authority')
  assert.equal(intersectRunPolicy(broad, undefined), broad)
})

test('an older ceiling with install, write or network denials restricts nothing', () => {
  const current = defaultRunPolicy()
  const ceiling = { ...defaultRunPolicy(), networkAllow: ['api.example.invalid'], networkCeiling: ['api.example.invalid'],
    permissions: { install_dependency: 'deny' as const, write_outside_repo: 'deny' as const, git_push: 'allow' as const, network: 'deny' as const } }
  const next = intersectRunPolicy(current, ceiling)
  assert.deepEqual(next.permissions, current.permissions)
  assert.equal(next.networkCeiling, undefined)
  assert.equal(next.readOnly, undefined)
})

test('a CLI-only ceiling leaves the broker computer grant as it is', () => {
  const unrestricted = defaultRunPolicy()
  delete unrestricted.permissions.computer_use
  const scoped = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use: 'allow' as const } }
  assert.equal(intersectRunPolicy(scoped, unrestricted).permissions.computer_use, 'allow')
  assert.equal(intersectRunPolicy(unrestricted, scoped).permissions.computer_use, undefined)
  assert.throws(() => intersectRunPolicy(scoped, { permissions: {} }))
})
