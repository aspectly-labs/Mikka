import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hashInvitationToken,
  normalizeInviterName,
  parseInvitationToken,
} from './invitation-preview-token.ts'

test('parseInvitationToken accepts only 64-char lowercase hex tokens and hashes consistently', () => {
  const valid = 'a'.repeat(64)
  assert.equal(parseInvitationToken(valid), valid)
  assert.equal(parseInvitationToken('0123456789abcdef'.repeat(4)), '0123456789abcdef'.repeat(4))
  assert.equal(parseInvitationToken('A'.repeat(64)), null)
  assert.equal(parseInvitationToken('a'.repeat(63)), null)
  assert.equal(parseInvitationToken('a'.repeat(65)), null)
  assert.equal(parseInvitationToken('not-a-token'), null)
  assert.equal(parseInvitationToken(''), null)
  assert.equal(parseInvitationToken(null), null)
  assert.equal(hashInvitationToken(valid).length, 64)
  assert.match(hashInvitationToken(valid), /^[a-f0-9]{64}$/)
  assert.notEqual(hashInvitationToken(valid), hashInvitationToken('b'.repeat(64)))
})

test('normalizeInviterName trims names and turns blank values into null', () => {
  assert.equal(normalizeInviterName('  Alex Jiang  '), 'Alex Jiang')
  assert.equal(normalizeInviterName('   '), null)
  assert.equal(normalizeInviterName(''), null)
  assert.equal(normalizeInviterName(null), null)
  assert.equal(normalizeInviterName(undefined), null)
})
