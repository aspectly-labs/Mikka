import assert from 'node:assert/strict'
import test from 'node:test'
import { renewStoredSession } from '../lib/session-renewal.ts'

const token = '__Secure-better-auth.session_token'
const jar = (cookies: Record<string, { value: string; expires: string | null }>) => JSON.stringify(cookies)

test('a renewal on an API response moves the stored session expiry forward', () => {
  const stored = jar({ [token]: { value: 'abc.sig', expires: '2026-11-24T03:00:00.000Z' } })
  const renewed = jar({ [token]: { value: 'abc.sig', expires: '2026-12-01T03:00:00.000Z' } })
  assert.deepEqual(JSON.parse(renewStoredSession(stored, renewed)!), { [token]: { value: 'abc.sig', expires: '2026-12-01T03:00:00.000Z' } })
})

test('other cookies in the jar are kept as they are', () => {
  const stored = jar({ [token]: { value: 'abc.sig', expires: '2026-11-24T03:00:00.000Z' }, other: { value: 'x', expires: null } })
  const renewed = jar({ [token]: { value: 'abc.sig', expires: '2026-12-01T03:00:00.000Z' } })
  assert.deepEqual(JSON.parse(renewStoredSession(stored, renewed)!).other, { value: 'x', expires: null })
})

test('a cookie the jar does not hold with the same value is left to the auth client', () => {
  const stored = jar({ [token]: { value: 'abc.sig', expires: '2026-11-24T03:00:00.000Z' } })
  // Another session (a new sign-in or another account) and a cookie the jar never held.
  assert.equal(renewStoredSession(stored, jar({ [token]: { value: 'new.sig', expires: '2026-12-01T03:00:00.000Z' } })), null)
  assert.equal(renewStoredSession(stored, jar({ 'better-auth.session_data': { value: 'cache', expires: '2026-12-01T03:00:00.000Z' } })), null)
  // Signed out meanwhile: an empty jar is not refilled.
  assert.equal(renewStoredSession('{}', jar({ [token]: { value: 'abc.sig', expires: '2026-12-01T03:00:00.000Z' } })), null)
  assert.equal(renewStoredSession(null, jar({ [token]: { value: 'abc.sig', expires: '2026-12-01T03:00:00.000Z' } })), null)
})

test('an expiry is never moved back, and an unchanged one writes nothing', () => {
  const stored = jar({ [token]: { value: 'abc.sig', expires: '2026-12-01T03:00:00.000Z' } })
  assert.equal(renewStoredSession(stored, jar({ [token]: { value: 'abc.sig', expires: '2026-11-25T03:00:00.000Z' } })), null)
  assert.equal(renewStoredSession(stored, stored), null)
  assert.equal(renewStoredSession('not json', stored), null)
})
