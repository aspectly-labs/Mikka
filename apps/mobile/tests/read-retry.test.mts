import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientReadFailure, readFailureOutcome, readRetryDelay, readWithRetry } from '../lib/read-retry.ts'

const httpFailure = (status: number) => Object.assign(new Error(`http${status}`), { status })

test('network errors, timeouts and busy-server statuses are retried; other answers are not', () => {
  assert.equal(isTransientReadFailure(new TypeError('Network request failed')), true)
  assert.equal(isTransientReadFailure(Object.assign(new Error('Aborted'), { name: 'AbortError' })), true)
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientReadFailure(httpFailure(status)), true, String(status))
  for (const status of [400, 401, 403, 404, 409, 426]) assert.equal(isTransientReadFailure(httpFailure(status)), false, String(status))
})

test('three jittered retries, then none', () => {
  assert.equal(readRetryDelay(0, () => 0), 300)
  assert.equal(readRetryDelay(0, () => 1), 500)
  assert.equal(readRetryDelay(1, () => 0.5), 1_200)
  assert.equal(readRetryDelay(2, () => 0.5), 3_000)
  assert.equal(readRetryDelay(3, () => 0.5), null)
})

test('a dropped connection on return to the app is retried and the read succeeds', async () => {
  const waits: number[] = []
  let calls = 0
  const value = await readWithRetry(async () => {
    calls++
    if (calls < 3) throw new TypeError('Network request failed')
    return 'settings'
  }, { canRetry: () => true, wait: async ms => { waits.push(ms) }, random: () => 0.5 })
  assert.equal(value, 'settings')
  assert.equal(calls, 3)
  assert.deepEqual(waits, [400, 1_200])
})

test('an answer such as 401 or 404 is not retried', async () => {
  let calls = 0
  await assert.rejects(readWithRetry(async () => { calls++; throw httpFailure(401) }, { canRetry: () => true, wait: async () => {} }), /http401/)
  assert.equal(calls, 1)
})

test('retries stop once spent, or when the read is superseded or the app leaves the foreground', async () => {
  let calls = 0
  await assert.rejects(readWithRetry(async () => { calls++; throw httpFailure(503) }, { canRetry: () => true, wait: async () => {} }), /http503/)
  assert.equal(calls, 4)

  calls = 0
  let current = true
  await assert.rejects(readWithRetry(async () => { calls++; throw new TypeError('Network request failed') }, {
    canRetry: () => current, wait: async () => { current = false },
  }))
  assert.equal(calls, 1)
})

test('only failures the person caused or asked about reach the screen', () => {
  // The app refreshed on its own and the screen still has content: keep it.
  assert.equal(readFailureOutcome({ transient: true, interrupted: false, mode: 'quiet', hasData: true }), 'hold')
  // iOS suspended the app during the read: redo it in the foreground.
  assert.equal(readFailureOutcome({ transient: true, interrupted: true, mode: 'shown', hasData: false }), 'hold')
  // Retry or pull to refresh, a first load with nothing to show: the person needs to know.
  assert.equal(readFailureOutcome({ transient: true, interrupted: false, mode: 'shown', hasData: true }), 'show')
  assert.equal(readFailureOutcome({ transient: true, interrupted: false, mode: 'quiet', hasData: false }), 'show')
  // The server's own answer is always shown.
  assert.equal(readFailureOutcome({ transient: false, interrupted: true, mode: 'quiet', hasData: true }), 'show')
})
