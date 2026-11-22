import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useRef } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ThreadGroupRow, TranscriptPin } from './thread-contract'

mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string) => key, useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }) } })

// A layout without a layout engine: 100px per message, a 600px view, a 24px column foot, the spacer's height as set.
const ROW = 100, VIEW = 600, FOOT = 24
const browser = new Window({ url: 'https://mikka.test/mikka' })
let reduced = false
const glides: { top: number; behavior?: string }[] = []
const scrollTops = new WeakMap<object, number>()
const column = (el: Element) => el.closest('[data-thread-host]')?.firstElementChild ?? null
const messageCount = (host: Element) => host.querySelectorAll('ol > li').length
const spacerHeight = (host: Element) => parseFloat((host.querySelector('[data-slot="send-pin-space"]') as HTMLElement | null)?.style.height || '0') || 0
const proto = browser.HTMLElement.prototype as unknown as HTMLElement
Object.defineProperty(proto, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-thread-host') ? VIEW : 0 } })
Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-thread-host') ? messageCount(this) * ROW + FOOT + spacerHeight(this) : 0 } })
Object.defineProperty(proto, 'scrollTop', { configurable: true,
  get(this: HTMLElement) { return scrollTops.get(this) ?? 0 },
  set(this: HTMLElement, value: number) { scrollTops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))) } })
proto.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
  const top = typeof options === 'object' ? options.top ?? 0 : 0
  glides.push({ top, behavior: typeof options === 'object' ? options.behavior : undefined })
  this.scrollTop = top
} as HTMLElement['scrollTo']
proto.getBoundingClientRect = function (this: HTMLElement) {
  const host = this.closest('[data-thread-host]') as HTMLElement | null
  const scrolled = host ? host.scrollTop : 0
  let top = 0, height = 0
  if (this.hasAttribute('data-thread-host')) height = VIEW
  else if (host && this === column(this)) { top = -scrolled; height = messageCount(host) * ROW + FOOT }
  else if (host && this.hasAttribute('data-message-id')) {
    const item = this.closest('li')!
    top = [...host.querySelectorAll('ol > li')].indexOf(item) * ROW - scrolled; height = ROW
  }
  return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON() {} } as DOMRect
}

let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadTranscript: typeof import('./thread-transcript')['ThreadTranscript']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  browser.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, ResizeObserver: undefined })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadTranscript } = await import('./thread-transcript'))
})
beforeEach(() => { reduced = false; glides.length = 0; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

const speaker = { id: 'group', name: 'Group' }
const others = (id: string): ThreadGroupRow => ({ kind: 'author', id, mine: false, quiet: true, name: 'Bot', messages: [{ id, message: { from: 'bot', speaker, presentation: 'group-reply', body: id } }] })
const sent = (id: string): ThreadGroupRow => ({ kind: 'pending', id, phase: 'sending', message: { from: 'person', speaker, presentation: 'group-sent', body: id } })

function Screen({ rows, pin }: { rows: ThreadGroupRow[]; pin: TranscriptPin }) {
  const ref = useRef<HTMLDivElement>(null)
  return <ThreadTranscript host="page" composer={null} transcript={{ kind: 'group', rows, scroll: { ref, label: 'messages', onScroll: () => {}, end: rows.at(-1)?.id, following: true, pin } }} />
}
const show = (rows: ThreadGroupRow[], pin: TranscriptPin) => act(async () => root.render(<Screen rows={rows} pin={pin} />))
const host = () => container.querySelector('[data-thread-host]') as HTMLElement
const history = [others('a'), others('b'), others('c')]

test('a load and someone else\'s message never pin: the chat follows its end with no space under it', async () => {
  await show(history, { sends: 4, target: 'c' })
  assert.equal(spacerHeight(host()), 0)
  assert.equal(host().scrollTop, 3 * ROW + FOOT - VIEW < 0 ? 0 : 3 * ROW + FOOT - VIEW)
  await show([...history, others('d')], { sends: 4, target: 'c' })
  assert.equal(spacerHeight(host()), 0)
})

test('the person\'s own send glides their message to the top; the space under it shrinks as replies arrive', async () => {
  await show(history, { sends: 0, target: null })
  await show([...history, sent('mine')], { sends: 1, target: 'mine' })
  // The message starts at 300px; the column ends at 424px: 600 − (424 − (300 − 16)) = 460px of space.
  assert.equal(spacerHeight(host()), 460)
  assert.deepEqual(glides.at(-1), { top: 4 * ROW + FOOT + 460 - VIEW, behavior: 'smooth' })
  await show([...history, sent('mine'), others('reply')], { sends: 1, target: 'mine', busy: true })
  assert.equal(spacerHeight(host()), 360)
  await show([...history, sent('mine'), others('reply'), others('more'), others('even more'), others('last'), others('full')], { sends: 1, target: 'mine', busy: true })
  assert.equal(spacerHeight(host()), 0, 'once the replies fill the view the space is gone')
})

test('with reduced motion the send jumps to the top instead of gliding', async () => {
  reduced = true
  await show(history, { sends: 0, target: null })
  glides.length = 0
  await show([...history, sent('mine')], { sends: 1, target: 'mine' })
  assert.equal(spacerHeight(host()), 460)
  assert.equal(glides.some(glide => glide.behavior === 'smooth'), false)
  assert.equal(host().scrollTop, 4 * ROW + FOOT + 460 - VIEW)
})
