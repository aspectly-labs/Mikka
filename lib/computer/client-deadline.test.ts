import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { computerReadDeadline } from './state-deadline'

// The mock flag is read when ./client loads: clear both of its names first, so
// a legacy NEXT_PUBLIC_COMPUTER_MOCK in the environment cannot leak in.
const MOCK_NAMES = ['MIKKA_PUBLIC_COMPUTER_MOCK', 'NEXT_PUBLIC_COMPUTER_MOCK'] as const

test('a slow actual state fetch caches its request-start clock for expiry and remount calculations', async () => {
  const original = globalThis.fetch
  const mockFlags = MOCK_NAMES.map(name => process.env[name])
  for (const name of MOCK_NAMES) delete process.env[name]
  const { computerApi } = await import('./client')
  let now = 1_000, resolve!: (response: Response) => void
  const clock = mock.method(performance, 'now', () => now)
  const botId = '40000000-0000-4000-8000-000000000001', workspaceId = '50000000-0000-4000-8000-000000000001'
  const deadline = { at: '2030-01-01T00:00:10.000Z', afterMs: 10_000 }
  let requests = 0
  globalThis.fetch = (async (url, options) => {
    requests++
    assert.ok(String(url).endsWith(`/api/bots/${botId}/computer`))
    assert.equal(options?.credentials, 'same-origin')
    return new Promise<Response>(finish => { resolve = finish })
  }) as typeof fetch
  try {
    const pending = computerApi.state(botId)
    now = 7_000
    resolve(Response.json({ machine: 'running', control: 'agent', live: { workspaceId, deadline }, requestedAt: 999_999_999 }))
    const read = await pending
    assert.equal(requests, 1)
    assert.equal(read.requestedAt, 1_000, 'only the browser request start supplies the cache clock')
    assert.deepEqual(computerReadDeadline(read), { at: deadline.at, afterMs: 4_000, observation: 1_000 })
    now = 10_000
    assert.deepEqual(computerReadDeadline(read), { at: deadline.at, afterMs: 1_000, observation: 1_000 }, 'a delayed mount does not restart the response lifetime')
    now = 12_000
    assert.deepEqual(computerReadDeadline(read), { at: deadline.at, afterMs: 0, observation: 1_000 })
  } finally {
    clock.mock.restore()
    globalThis.fetch = original
    MOCK_NAMES.forEach((name, index) => { const value = mockFlags[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value })
  }
})
