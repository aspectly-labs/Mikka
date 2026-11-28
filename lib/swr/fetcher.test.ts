import assert from 'node:assert/strict'
import test from 'node:test'
import { actionFetcher, isTypedFetcher, keyedFetcher, noArgFetcher, urlFetcher, type KeyedFetcher } from './fetcher'
import { isSnapshotReadFetcher, snapshotReadFetcher } from './read-observer'
import { factoryGet, factoryGetFetcher, RequestError } from '@/lib/factory/browser-request'

test('noArgFetcher / actionFetcher never forwards SWR cache keys at runtime and preserves snapshotReadFetcher', async () => {
  const received: unknown[][] = []
  async function listTeams() {
    received.push([...arguments])
    return ['team-a']
  }

  const wrapped = actionFetcher(listTeams)
  assert.equal(isTypedFetcher(wrapped), true)
  const result = await (wrapped as (...args: unknown[]) => Promise<string[]>)('teams', 'extra-arg')
  assert.deepEqual(result, ['team-a'])
  assert.deepEqual(received, [[]], 'SWR key must never reach the underlying 0-arg read')

  const snap = snapshotReadFetcher(async () => 'ok')
  const wrappedSnap = noArgFetcher(snap)
  assert.equal(isSnapshotReadFetcher(wrappedSnap), true)
  assert.equal(await wrappedSnap('ignored-key'), 'ok')
})

test('urlFetcher forwards only the single URL string argument', async () => {
  const received: unknown[][] = []
  async function readUrl(url: string) {
    received.push([...arguments])
    return { url }
  }
  const fetcher = urlFetcher(readUrl)
  assert.equal(isTypedFetcher(fetcher), true)
  const result = await (fetcher as (...args: unknown[]) => Promise<{ url: string }>)('/api/items', { unexpectedBody: true })
  assert.deepEqual(result, { url: '/api/items' })
  assert.deepEqual(received, [['/api/items']])
})

test('keyedFetcher preserves typed tuple key mapping and snapshotReadFetcher mark', async () => {
  type ItemKey = readonly ['item', string, number]
  const raw = snapshotReadFetcher(async ([, id, page]: ItemKey) => `${id}:${page}`)
  const fetcher = keyedFetcher(raw)
  assert.equal(isTypedFetcher(fetcher), true)
  assert.equal(isSnapshotReadFetcher(fetcher), true)
  assert.equal(await fetcher(['item', 'abc', 2]), 'abc:2')
})

test('factoryGet and factoryGetFetcher always issue GET requests and throw RequestError on failure', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    if (String(input).includes('fail')) {
      return new Response(JSON.stringify({ error: 'denied' }), { status: 403 })
    }
    return new Response(JSON.stringify({ tasks: [{ id: 't1' }] }), { status: 200 })
  }) as typeof fetch

  const data = await factoryGet<{ tasks: { id: string }[] }>('/api/factory/tasks')
  assert.deepEqual(data, { tasks: [{ id: 't1' }] })
  assert.equal(calls[0]?.init?.method, undefined)

  const fetcher = factoryGetFetcher<{ tasks: { id: string }[] }>()
  assert.equal(isTypedFetcher(fetcher), true)
  // Even if SWR or middleware calls with extra args, factoryGetFetcher forwards only the URL string (never POST).
  const data2 = await (fetcher as (...args: unknown[]) => Promise<{ tasks: { id: string }[] }>)('/api/factory/tasks', { body: 'should-be-dropped' })
  assert.deepEqual(data2, { tasks: [{ id: 't1' }] })
  assert.equal(calls[1]?.init?.method, undefined)

  await assert.rejects(() => factoryGet('/api/factory/fail'), (err: unknown) => err instanceof RequestError && err.status === 403 && err.code === 'denied')
})

test('compile-time type guards reject optional-arg actions and mismatched keys', () => {
  // Type-only compile checks verified by `pnpm typecheck`:
  const verifyTypes = () => {
    const withOptionalParam = async (workspaceId?: string) => workspaceId ?? 'default'
    // @ts-expect-error F3 guard: an action with an optional parameter must not be passed bare to actionFetcher
    actionFetcher(withOptionalParam)

    const withRequiredParam = async (id: string) => id
    // @ts-expect-error F3 guard: a function taking a required parameter must not be passed to noArgFetcher
    noArgFetcher(withRequiredParam)

    // Wrapping in a 0-arg thunk compiles cleanly:
    const safe: KeyedFetcher<string | readonly [string, ...unknown[]], string> = actionFetcher(() => withOptionalParam())

    const tupleFetcher = keyedFetcher(([, id]: readonly ['bot', string]) => Promise.resolve(id.length))
    // @ts-expect-error mismatched tuple key element type
    void tupleFetcher(['bot', 42])
    void tupleFetcher(['bot', 'bot-1'])
    void safe
  }
  assert.equal(typeof verifyTypes, 'function')
})
