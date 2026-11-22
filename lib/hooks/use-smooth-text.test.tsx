import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { SMOOTH_TEXT, useSmoothText } from './use-smooth-text'

// A streaming reply's text, revealed at LobeHub's pace: driven here by hand-stepped animation frames and a hand-set
// clock, so every frame is seen and nothing depends on real time.
const browser = new Window({ url: 'https://mikka.example/en' })
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let clock = 0
let reduced = false
let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
const shown: string[] = []

before(async () => {
  for (const key of ['window', 'document', 'HTMLElement'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(nextFrame, callback); return nextFrame++ } })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id) } })
  Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => clock })
  Object.defineProperty(browser, 'matchMedia', { configurable: true, value: (query: string) => ({ matches: reduced && query.includes('reduce'), addEventListener() {}, removeEventListener() {} }) })
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => {
  clock = 1000; reduced = false; frames = new Map(); shown.length = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

function Reply({ text, live }: { text: string; live: boolean }) {
  const value = useSmoothText(text, live)
  shown.push(value)
  return <p>{value}</p>
}
const render = (text: string, live: boolean) => act(async () => root.render(<Reply text={text} live={live} />))
const now = () => container.textContent ?? ''
/** Moves the clock on by `ms` in 16 ms frames, running whatever frame is waiting. */
async function run(ms: number) {
  for (let left = ms; left > 0; left -= 16) {
    clock += 16
    const waiting = [...frames.entries()]
    frames = new Map()
    await act(async () => { for (const [, callback] of waiting) callback(clock) })
  }
}

test('stored text shows whole at once, with no frame loop', async () => {
  await render('A stored reply, read back from the thread.', false)
  assert.equal(now(), 'A stored reply, read back from the thread.')
  await render('A stored reply, read back from the thread. Edited.', false)
  assert.equal(now(), 'A stored reply, read back from the thread. Edited.')
  assert.equal(frames.size, 0)
})

test('live text arrives a few characters at a time, always a prefix and in order, then the loop stops', async () => {
  const reply = 'Looked at the sign-in redirect: the callback drops the next parameter, so I am fixing it now. 好的，这样就行了 😀.'
  await render('', true)
  for (let at = 0; at < reply.length; at += 6) {
    clock += 40
    await render(reply.slice(0, at + 6), true)
    await run(32)
  }
  await run(2000)
  assert.equal(now(), reply)
  for (const value of shown) assert.ok(reply.startsWith(value), `a prefix, never reordered: ${JSON.stringify(value)}`)
  const distinct = [...new Set(shown)]
  assert.ok(distinct.length > reply.length / 6, 'more steps than the chunks it arrived in')
  for (const value of distinct) assert.ok(!/[\uD800-\uDBFF]$/.test(value), 'never half an emoji')
  assert.equal(frames.size, 0, 'caught up: no frame waits')
})

test('text arriving faster than it can be shown never falls more than the lag cap behind', async () => {
  const reply = 'x'.repeat(600)
  const lags: number[] = []
  await render('', true)
  for (let at = 0; at < reply.length; at += 20) {
    clock += 16
    await render(reply.slice(0, at + 20), true)
    await run(16)
    lags.push(at + 20 - now().length)
  }
  assert.ok(Math.max(...lags) <= SMOOTH_TEXT.maxLagChars, `lags ${lags}`)
  assert.ok(lags.some(lag => lag > 20), 'it was behind before it caught up')
  assert.ok(lags.some((lag, index) => index > 0 && lag < lags[index - 1] - 20), 'and caught up at once')
})

test('the end of the stream shows the rest at once', async () => {
  await render('', true)
  clock += 50
  await render('The first part of a reply that is still coming in,', true)
  await run(48)
  assert.ok(now().length < 50, 'behind mid-stream')
  await render('The first part of a reply that is still coming in, and its end.', false)
  assert.equal(now(), 'The first part of a reply that is still coming in, and its end.')
  assert.equal(frames.size, 0)
})

test('a large chunk, or text that is not a continuation, shows at once', async () => {
  await render('Start', true)
  await render(`Start ${'y'.repeat(SMOOTH_TEXT.largeAppendChars + 1)}`, true)
  assert.equal(now(), `Start ${'y'.repeat(SMOOTH_TEXT.largeAppendChars + 1)}`)
  clock += 100
  await render('Something else entirely', true)
  assert.equal(now(), 'Something else entirely')
})

test('reduced motion shows live text as it arrives, with no frame loop', async () => {
  reduced = true
  await render('', true)
  await render('Every chunk', true)
  assert.equal(now(), 'Every chunk')
  await render('Every chunk at once.', true)
  assert.equal(now(), 'Every chunk at once.')
  assert.equal(frames.size, 0)
})
