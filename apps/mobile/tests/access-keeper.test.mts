import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccessKeeper, ROTATE_BEFORE_MS, type AccessKeeperDeps, type ExchangeResult, type IssuedCredential, type RefreshCredential, type RotateResult } from '../lib/access-keeper.ts'

const HOUR = 3_600_000
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const credential = (n: number, accessInMs = HOUR, userId = 'u1', sessionId = 's1'): RefreshCredential => ({
  userId, sessionId, bindingSessionId: sessionId, refreshToken: `mkmr_${String(n).padStart(43, '0')}`, refreshExpiresAt: new Date(Date.now() + 60 * 24 * HOUR).toISOString(), accessExpiresAt: new Date(Date.now() + accessInMs).toISOString(),
})

function fixture(stored: Record<string, RefreshCredential | null> = {}, owner?: string) {
  const store = new Map(Object.entries(stored))
  let failWrites = 0
  const calls = { rotate: [] as string[], exchange: 0, revoke: [] as string[] }
  let answers: (() => Promise<RotateResult>)[] = []
  let exchangeAnswer: () => Promise<ExchangeResult> = async () => ({ status: 'unavailable' })
  const deps: AccessKeeperDeps = {
    read: async account => store.get(account) ?? null,
    write: async (account, value) => { if (failWrites > 0) { failWrites--; throw new Error('errSecInteractionNotAllowed') } store.set(account, value) },
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
    failNextWrites(count: number) { failWrites = count },
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

test('an offline launch exchanges on the next request once the phone is back online, with the same session', async () => {
  const f = fixture()
  const settle = () => new Promise(resolve => setImmediate(resolve))
  // Launched offline: the sign-in is there (cached), the server is not.
  f.exchangeWith(async () => ({ status: 'unavailable' }))
  await Promise.all([f.keeper.ensureExchanged('a', 'u1', 's1'), f.keeper.ensureExchanged('a', 'u1', 's1')])
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.calls.exchange, 1, 'the sign-in asks once')
  await f.keeper.prepare('a'); await settle()
  assert.equal(f.calls.exchange, 2, 'a request made while still offline asks again')
  // Back online, same session: nothing re-runs the sign-in effect, the next request does.
  f.exchangeWith(async () => ({ status: 'ok', credential: credential(1) }))
  await f.keeper.prepare('a'); await settle()
  assert.equal(f.calls.exchange, 3)
  assert.equal(f.store.get('a')?.refreshToken, credential(1).refreshToken)
  assert.equal(f.keeper.held('a'), 'held')
  await f.keeper.prepare('a'); await settle()
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.calls.exchange, 3, 'held: no exchange')
  assert.equal(f.calls.rotate.length, 0, 'a fresh credential is not rotated')
})

test('an exchange the server refused is not asked again; a sign-out drops an unanswered one', async () => {
  const f = fixture()
  const settle = () => new Promise(resolve => setImmediate(resolve))
  f.exchangeWith(async () => ({ status: 'refused' }))
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  await f.keeper.prepare('a'); await settle()
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.calls.exchange, 1, 'an organization SSO session keeps today\'s behaviour without asking on every request')
  f.exchangeWith(async () => ({ status: 'unavailable' }))
  await f.keeper.ensureExchanged('b', 'u1', 's1')
  await f.keeper.forget('b')
  await f.keeper.prepare('b'); await settle()
  assert.equal(f.calls.exchange, 2, 'signed out: no exchange for the old sign-in')
  // Someone else signed in to the slot meanwhile: the unanswered exchange is not theirs to make.
  const g = fixture({}, 'u2')
  g.exchangeWith(async () => ({ status: 'unavailable' }))
  await g.keeper.ensureExchanged('c', 'u1', 's1')
  await g.keeper.prepare('c'); await settle()
  assert.equal(g.calls.exchange, 1)
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

test('a session replaced in the same sign-in keeps the binding the outbox and cache use', async () => {
  const f = fixture()
  f.exchangeWith(async () => ({ status: 'ok', credential: credential(1, HOUR, 'u1', 's1') }))
  await f.keeper.ensureExchanged('a', 'u1', 's1')
  assert.equal(f.keeper.binding('a', 'u1', 's1'), 's1')
  // Renewed in place: the same session.
  f.answer(async () => ({ status: 'ok', credential: credential(2, HOUR, 'u1', 's1') }))
  await f.keeper.recover('a', 0)
  assert.equal(f.keeper.binding('a', 'u1', 's1'), 's1')
  // Better Auth had deleted the row: rotation minted s2, still the same sign-in.
  f.answer(async () => ({ status: 'ok', credential: credential(3, HOUR, 'u1', 's2') }))
  await f.keeper.recover('a', f.keeper.generation('a'))
  assert.equal(f.keeper.binding('a', 'u1', 's2'), 's1', 'the outbox is not erased')
  assert.equal(f.keeper.binding('a', 'u1', null), 's1', 'a cold launch before the session is read binds the same')
  assert.equal(f.store.get('a')?.bindingSessionId, 's1', 'and it survives a restart')
  assert.equal(f.keeper.binding('a', 'u1', 'other'), null, 'another sign-in is its own binding')
  assert.equal(f.keeper.binding('a', 'u2', 's2'), null)
})

test('a renewal is announced, so screens holding sign-in headers take the new cookie', async () => {
  const f = fixture({ a: credential(1) })
  assert.equal(f.keeper.held('a'), 'unknown')
  await f.keeper.prepare('a')
  let notified = 0
  const stop = f.keeper.subscribe(() => { notified++ })
  f.answer(async () => ({ status: 'ok', credential: credential(2) }))
  const before = f.keeper.generation('a')
  await f.keeper.recover('a', before)
  stop()
  assert.equal(f.keeper.generation('a'), before + 1)
  assert.ok(notified > 0)
})

test('a keychain write that fails is retried, and written again before the next use', async () => {
  const f = fixture({ a: credential(1) })
  f.failNextWrites(1)
  f.answer(async () => ({ status: 'ok', credential: credential(2) }))
  await f.keeper.recover('a', 0)
  assert.equal(f.store.get('a')?.refreshToken, credential(2).refreshToken, 'the immediate retry kept it')
  f.failNextWrites(2)
  f.answer(async () => ({ status: 'ok', credential: credential(3) }))
  await f.keeper.recover('a', f.keeper.generation('a'))
  assert.equal(f.store.get('a')?.refreshToken, credential(2).refreshToken, 'the locked keychain still holds the previous token')
  await f.keeper.prepare('a')
  assert.equal(f.store.get('a')?.refreshToken, credential(3).refreshToken, 'written before the next request')
})
