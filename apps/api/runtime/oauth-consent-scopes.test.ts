import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRequestedOAuthScopes } from './oauth-consent-scopes'

test('parseRequestedOAuthScopes parses, deduplicates, and validates OAuth consent scopes', () => {
  assert.deepEqual(parseRequestedOAuthScopes(new URLSearchParams('')), [])
  assert.deepEqual(parseRequestedOAuthScopes(new URLSearchParams('scope=mikka')), ['mikka'])
  assert.deepEqual(
    parseRequestedOAuthScopes(new URLSearchParams('scope=mikka%20offline_access%20mikka%20tasks:read')),
    ['mikka', 'offline_access', 'tasks:read'],
  )
  assert.equal(parseRequestedOAuthScopes(new URLSearchParams('scope=mikka&scope=offline_access')), null)
  assert.equal(parseRequestedOAuthScopes(new URLSearchParams(`scope=${'a'.repeat(1025)}`)), null)
  assert.equal(parseRequestedOAuthScopes(new URLSearchParams('scope=mikka%20bad<script>')), null)
  assert.equal(
    parseRequestedOAuthScopes(new URLSearchParams(`scope=${Array.from({ length: 33 }, (_, i) => `s${i}`).join(' ')}`)),
    null,
  )
})
