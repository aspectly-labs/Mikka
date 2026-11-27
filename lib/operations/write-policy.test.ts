import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWritePermission } from './write-policy'

test('only an explicit deny blocks; absence, allow and an old stored ask all run', () => {
  assert.equal(resolveWritePermission('write_document', [{}]), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ network: 'deny' }]), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, { write_document: 'allow' }]), 'allow')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'ask' }]), 'allow', 'there is no approval (ADR 2026-11-27-1615)')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'allow' }, { write_document: 'deny' }]), 'deny')
  assert.equal(resolveWritePermission('write_document', [{ write_document: 'deny' }, { write_document: 'allow' }]), 'deny')
  for (const layers of [[], [null], [{ write_document: 'other' }]]) assert.throws(() => resolveWritePermission('write_document', layers), /writePolicyUnavailable/)
})
