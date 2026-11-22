import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

mock.module(new URL('./scope.ts', import.meta.url).href, { namedExports: { assertEveScope: async (scope: unknown) => scope } })
mock.module(new URL('./server-client.ts', import.meta.url).href, { namedExports: { eveInternalOrigin: () => 'http://127.0.0.1:3000/mikka/api/agents' } })
mock.module(new URL('./retry.ts', import.meta.url).href, { namedExports: { eveRetryHeaders: (request: Headers) => Object.fromEntries(request) } })
const { reviseEveTurn, revisionMessage } = await import('./revise')

const scope = { ownerId: 'owner', botId: '10000000-0000-4000-8000-000000000001', workspaceId: '10000000-0000-4000-8000-000000000002', surface: 'web' as const }
const input = { operation: 'regenerate' as const, position: 4, requestId: '10000000-0000-4000-8000-000000000003' }
const headers = new Headers({ cookie: 'session=1' })
const idleEvents: unknown[] = []

function harness(options: { working?: boolean; clear?: 'completed' | 'failed'; cleared?: boolean } = {}) {
  const calls: string[] = []
  const services = {
    async open() {
      calls.push('open')
      return {
        id: 'wrun_1',
        async snapshot() { return { events: options.working ? [{ type: 'turn.started', data: { turnId: 't1', cause: { deliveryId: 'delivery_0' }, follows: null }, scope: { turnId: 't1' }, meta: { position: { line: 0, index: 0 }, at: '2026-11-22T00:00:00Z', endOfLine: true } }] : idleEvents } },
        async clear() { calls.push('clear'); return { async result() { return options.clear === 'failed' ? { status: 'failed', error: { code: 'x' } } : { status: 'completed' } } } },
        async send(message: unknown, sendOptions: { headers?: Record<string, string> }) { calls.push(`send:${JSON.stringify(message)}:${sendOptions.headers?.['x-mikka-submission-id']}`); return {} },
      }
    },
    async begin() { calls.push('begin'); return { id: 'rev', submissionId: 'sub', text: 'Say it simply', images: [], cleared: options.cleared ?? false } },
    async abandon() { calls.push('abandon') },
    async cleared() { calls.push('cleared') },
  }
  return { calls, services: services as never }
}

test('the turn leaves the chat, eve clears the history, then the words go again under the revision’s submission id', async () => {
  const { calls, services } = harness()
  assert.deepEqual(await reviseEveTurn(scope, input, headers, services), { queued: true, submissionId: 'sub' })
  assert.deepEqual(calls, ['open', 'begin', 'clear', 'cleared', 'send:"Say it simply":sub'])
})

test('a working chat changes nothing', async () => {
  const { calls, services } = harness({ working: true })
  assert.deepEqual(await reviseEveTurn(scope, input, headers, services), { queued: false, reason: 'working' })
  assert.deepEqual(calls, ['open'])
})

test('a clear eve refuses puts the turn back and sends nothing', async () => {
  const { calls, services } = harness({ clear: 'failed' })
  assert.deepEqual(await reviseEveTurn(scope, input, headers, services), { queued: false, reason: 'unavailable' })
  assert.deepEqual(calls, ['open', 'begin', 'clear', 'abandon'])
})

test('the same request after a clear only sends', async () => {
  const { calls, services } = harness({ cleared: true })
  await reviseEveTurn(scope, input, headers, services)
  assert.deepEqual(calls, ['open', 'begin', 'send:"Say it simply":sub'])
})

test('images go with the words, as a resend sends them', () => {
  assert.deepEqual(revisionMessage({ id: 'r', submissionId: 's', text: 'Look', images: [{ dataUrl: 'data:image/png;base64,AA', mediaType: 'image/png' }], cleared: false }),
    [{ type: 'text', text: 'Look' }, { type: 'file', data: 'data:image/png;base64,AA', mediaType: 'image/png' }])
  assert.equal(revisionMessage({ id: 'r', submissionId: 's', text: 'Plain', images: [], cleared: false }), 'Plain')
})
