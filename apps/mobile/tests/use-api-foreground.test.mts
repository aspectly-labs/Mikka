import assert from 'node:assert/strict'
import test, { after, afterEach, before, beforeEach, mock } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'

// The real useApi hook and read policy; only the native AppState, the API
// transport and time are ports. Covers returning to the app (lib/read-retry.ts).
const origin = 'https://app.test', start = 1_800_000_000_000
const browser = new Window({ url: origin })
const listeners = new Set<(state: string) => void>()
const appState = {
  currentState: 'active',
  addEventListener: (_event: string, listener: (state: string) => void) => { listeners.add(listener); return { remove: () => { listeners.delete(listener) } } },
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }
type Settings = { name: string }
class ApiError extends Error { constructor(readonly status: number, code: string) { super(code) } }

// Each read takes the next scripted answer: a value, or an error to throw.
let answers: (Settings | Error)[] = []
let reads = 0
let hold: { resolve: () => void } | null = null
const read = async (): Promise<Settings> => {
  reads++
  if (hold) await new Promise<void>(resolve => { hold = { resolve } })
  const next = answers.shift() ?? new TypeError('Network request failed')
  if (next instanceof Error) throw next
  return next
}

let hooks: typeof import('../lib/useApi.ts'), createRoot: typeof import('react-dom/client').createRoot
let view: ReturnType<typeof createRoot> | null = null, container: HTMLElement | null = null
let state: ReturnType<typeof hooks.useApi<Settings>> | null = null
function Page() { state = hooks.useApi<Settings>('/api/mobile/settings?view=profile', { read }); return null }

before(async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  mock.module('react-native', { namedExports: { AppState: appState, Platform: { OS: 'ios' } } })
  mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { api: read, ApiError, onWorkspaceChange: () => () => {} } })
  mock.module(new URL('../lib/live.ts', import.meta.url).href, { namedExports: { live: { reset: () => {} }, useLive: () => {} } })
  hooks = await import('../lib/useApi.ts')
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { answers = []; reads = 0; hold = null; state = null; appState.currentState = 'active'; hooks.clearApiCache() })
afterEach(async () => {
  if (view) { await act(async () => { view!.unmount() }); view = null }
  container?.remove(); container = null
  assert.equal(listeners.size, 0, 'unmount removes every native AppState listener')
})
after(async () => { mock.timers.reset(); mock.restoreAll(); await browser.happyDOM.close() })

async function mount() {
  container = browser.document.createElement('div') as unknown as HTMLElement; document.body.append(container)
  view = createRoot(container)
  await act(async () => { view!.render(createElement(Page)); await flush() })
}
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) await act(async () => { mock.timers.tick(Math.min(500, ms - elapsed)); await flush() })
}
async function setAppState(next: string) {
  appState.currentState = next
  await act(async () => { for (const listener of [...listeners]) listener(next); await flush() })
}
/** Leave the app for longer than the freshness window, then come back. */
async function awayAndBack() {
  await setAppState('background')
  await advance(61_000)
  await setAppState('active')
}

test('a failed refresh on return keeps the content on screen and shows no error', async () => {
  answers = [{ name: 'first' }]
  await mount()
  assert.deepEqual(state!.data, { name: 'first' })
  answers = [new TypeError('Network request failed'), new TypeError('Network request failed'), new TypeError('Network request failed'), new TypeError('Network request failed')]
  await awayAndBack()
  await advance(6_000)
  assert.equal(reads, 5, 'one first load, then the return read and its three retries')
  assert.deepEqual(state!.data, { name: 'first' })
  assert.equal(state!.error, null)
})

test('a dropped connection on return is retried and the new content arrives', async () => {
  answers = [{ name: 'first' }]
  await mount()
  answers = [new TypeError('Network request failed'), { name: 'second' }]
  await awayAndBack()
  await advance(1_000)
  assert.deepEqual(state!.data, { name: 'second' })
  assert.equal(state!.error, null)
})

test('the server answering 401 or 404 is not retried', async () => {
  answers = [{ name: 'first' }]
  await mount()
  answers = [new ApiError(401, 'authRequired')]
  await awayAndBack()
  await advance(6_000)
  assert.equal(reads, 2)
  assert.equal((state!.error as ApiError | null)?.status, 401)
})

test('Retry that fails after its retries shows the error', async () => {
  answers = [{ name: 'first' }]
  await mount()
  answers = []
  let done = false
  await act(async () => { void state!.reload().then(() => { done = true }); await flush() })
  await advance(6_000)
  assert.equal(done, true)
  assert.ok(state!.error)
  assert.deepEqual(state!.data, { name: 'first' })
})

test('a Retry cut off by leaving the app is redone on return, and still shows its failure', async () => {
  answers = [{ name: 'first' }]
  await mount()
  hold = { resolve: () => {} }
  await act(async () => { void state!.reload(); await flush() })
  // iOS suspends the app; the request fails when it resumes in the background.
  await setAppState('background')
  hold.resolve(); hold = null
  await advance(1_000)
  assert.equal(state!.error, null, 'the interruption itself is not an error')
  await setAppState('active')
  await advance(6_000)
  assert.ok(state!.error, 'the redone Retry exhausted its attempts, so the person sees it failed')
  assert.deepEqual(state!.data, { name: 'first' })
})
