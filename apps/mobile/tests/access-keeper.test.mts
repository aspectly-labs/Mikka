import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccessKeeper, ROTATE_BEFORE_MS, type AccessKeeperDeps, type RefreshCredential, type RotateResult } from '../lib/access-keeper.ts'

const HOUR = 3_600_000
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const credential = (n: number, accessInMs = HOUR, userId = 'u1'): RefreshCredential => ({
  userId, refreshToken: `mkmr_${String(n).padStart(43, '0')}`, refreshExpiresAt: new Date(Date.now() + 60 * 24 * HOUR).toISOString(), accessExpiresAt: new Date(Date.now() + accessInMs).toISOString(),
})

function fixture(stored: Record<string, RefreshCredential | null> = {}, owner?: string) {
  const store = new Map(Object.entries(stored))
  const calls = { rotate: [] as string[], exchange: 0, revoke: [] as string[] }
  let answers: (() => Promise<RotateResult>)[] = []
  let exchangeAnswer: () => Promise<{ status: 'ok'; credential: RefreshCredential } | { status: 'unavailable' }> = async () => ({ status: 'unavailable' })
  const deps: AccessKeeperDeps = {
    read: async account => store.get(account) ?? null,
    write: async (account, value) => { store.set(account, value) },
    clear: async account => { store.delete(account) },
    rotate: (_account, token) => { calls.rotate.push(token); return (answers.shift() ?? (async () => ({ status: 'unavailable' as const })))() },
    exchange: () => { calls.exchange++; return exchangeAnswer() },
    revoke: async (_account, token) => { calls.revoke.push(token) },
    ...(owner ? { owner: () => owner } : {}),
    now: () => Date.now(),
  }
  return {
    keeper: createAccessKeeper(deps), store, calls,
    answer(...next: (() => Promise<RotateResult>)[]) { answers = next },
    exchangeWith(next: typeof exchangeAnswer) { exchangeAnswer = next },
  }
}

test('concurrent 401s share one rotation; a 401 for a request sent before it just replays', async () => {
  const f = fixture({ a: credential(1) })
  const gate = deferred<RotateResult>()
  f.answer(() => gate.promise)
  const generation = f.keeper.generation('a')
  const waiting = Promise.all([1, 2, 3, 4, 5].map(() => f.keeper.recover('a', generation)))
  await new Promise(resolve => setImmediate(resolve))
  gate.resolve({ status: 'ok', credential: credential(2) })
  assert.deepEqual(await waiting, ['rotated', 'rotated', 'rotated', 'rotated', 'rotated'])
  assert.equal(f.calls.rotate.length, 1)
  assert.equal(f.store.get('a')?.refreshToken, credential(2).refreshToken, 'the next token is kept in the keychain')
  // A request sent before that rotation answered 401 afterwards: no second rotation.
  assert.equal(await f.keeper.recover('a', generation), 'rotated')
  assert.equal(f.calls.rotate.length, 1)
})

test('only refreshRejected ends the credential; network, 5xx and 404 keep it', async () => {
  const f = fixture({ a: credential(1) })
  f.answer(async () => ({ status: 'unavailable' }), async () => ({ status: 'unavailable' }))
  assert.equal(await f.keeper.recover('a', 0), 'unavailable')
  assert.equal(f.calls.rotate.length, 2, 'a lost answer is retried once at once, inside the server grace window')
  assert.ok(f.store.get('a'), 'still held')
  assert.equal(f.keeper.held('a'), 'held')
  f.answer(async () => { throw new TypeError('Network request failed') }, async () => ({ status: 'ok', credential: credential(3) }))
  assert.equal(await f.keeper.recover('a', 0), 'rotated', 'the retry may land')
  f.answer(async () => ({ status: 'rejected' }))
  assert.equal(await f.keeper.recover('a', f.keeper.generation('a')), 'rejected')
  assert.equal(f.store.has('a'), false)
  assert.equal(f.keeper.held('a'), 'none')
  assert.equal(await f.keeper.recover('a', f.keeper.generation('a')), 'none', 'no credential, no rotation')
})

test('an access session about to end is renewed before a request; one with time left is not', async () => {
  const f = fixture({ soon: credential(1, ROTATE_BEFORE_MS - 1000), later: credential(2, ROTATE_BEFORE_MS + 60_000) })
  f.answer(async () => ({ status: 'ok', credential: credential(3) }))
  await f.keeper.prepare('later')
  assert.equal(f.calls.rotate.length, 0)
  await Promise.all([f.keeper.prepare('soon'), f.keeper.prepare('soon')])
  assert.deepEqual(f.calls.rotate, [credential(1).refreshToken])
  await f.keeper.prepare('none')
  assert.equal(f.calls.rotate.length, 1)
})

test('exchange runs once per session until the app comes back to the foreground', async () => {
  const f = fixture()
  f.exchangeWith(async () => ({ status: 'unavailable' }))
  await Promise.all([f.keeper.ensureExchanged('a', 'u1', 's1'), f.keeper.ensureExchanged('a', 'u1', 's1')])
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.calls.exchange, 1, 'a failure is not retried in the same foreground')
  await f.keeper.foreground('a')
  f.exchangeWith(async () => ({ status: 'ok', credential: credential(1) }))
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.calls.exchange, 2)
  assert.equal(f.store.get('a')?.refreshToken, credential(1).refreshToken)
  await f.keeper.foreground('a')
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.calls.exchange, 2, 'held: no exchange')
  // A new sign-in in the slot (another session) may exchange at once.
  await f.keeper.ensureExchanged('a', 'u1', 's2')
  assert.equal(f.calls.exchange, 2)
})

test('a credential for another person in the slot is dropped, never rotated', async () => {
  const f = fixture({ a: credential(1, HOUR, 'someone-else') })
  f.exchangeWith(async () => ({ status: 'ok', credential: credential(2) }))
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.store.get('a')?.userId, 'u1')
  assert.equal(f.calls.rotate.length, 0)
  f.exchangeWith(async () => ({ status: 'ok', credential: credential(3, HOUR, 'intruder') }))
  const g = fixture()
  g.exchangeWith(async () => ({ status: 'ok', credential: credential(3, HOUR, 'intruder') }))
  await g.keeper.ensureExchanged('b', 'u1', 's1')
  assert.equal(g.store.has('b'), false, 'an answer for another person is not stored')
  // The slot is signed in as someone else now: the old credential is dropped, not rotated.
  const h = fixture({ c: credential(4, HOUR, 'previous') }, 'u1')
  assert.equal(await h.keeper.recover('c', 0), 'rejected')
  assert.equal(h.calls.rotate.length, 0)
  assert.equal(h.store.has('c'), false)
})

test('signing out revokes on the server and forgets it here; a rotation answer after that is dropped', async () => {
  const f = fixture({ a: credential(1) })
  const gate = deferred<RotateResult>()
  f.answer(() => gate.promise)
  const rotating = f.keeper.recover('a', 0)
  await new Promise(resolve => setImmediate(resolve))
  await f.keeper.forget('a')
  gate.resolve({ status: 'ok', credential: credential(2) })
  assert.equal(await rotating, 'unavailable')
  assert.equal(f.store.has('a'), false, 'the signed-out slot stays empty')
  assert.deepEqual(f.calls.revoke, [credential(1).refreshToken])
  assert.equal(f.keeper.held('a'), 'none')
})
