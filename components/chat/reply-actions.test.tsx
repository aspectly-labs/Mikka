import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string, values?: { time?: string }) => values?.time ? `${namespace}.${key} ${values.time}` : `${namespace}.${key}`,
  useFormatter: () => ({ dateTime: (value: Date) => `at:${value.toISOString()}` }),
} })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ReplyActions: typeof import('./reply-actions')['ReplyActions']

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ReplyActions } = await import('./reply-actions'))
})
beforeEach(() => { container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())

const reply = () => container.querySelector('button[aria-label="AiElements.message.reply"]') as HTMLButtonElement | null

test('the line shows when the message was sent, then Reply and Copy, then what the caller adds', async () => {
  const at = Date.UTC(2025, 10, 19, 14, 41)
  await act(async () => root.render(<ReplyActions at={at} copyText="the reply" onQuote={() => {}}><span data-extra="" /></ReplyActions>))
  const line = container.querySelector('[data-slot="message-actions"]')!
  const time = line.querySelector('time')!
  assert.equal(time.getAttribute('datetime'), new Date(at).toISOString())
  assert.match(time.textContent!, /Nov 19/)
  assert.equal(time.getAttribute('title'), `at:${new Date(at).toISOString()}`)
  const order = [...line.children].map(child => child.tagName === 'TIME' ? 'time' : child.getAttribute('aria-label') ?? (child.hasAttribute('data-extra') ? 'extra' : child.tagName))
  assert.deepEqual(order, ['time', 'AiElements.message.reply', 'AiElements.message.copy', 'extra'])
})

test('a message from today shows today and the clock, not the date (as the centred stamp)', async () => {
  const at = Date.now()
  await act(async () => root.render(<ReplyActions at={at} copyText="the reply" />))
  const clock = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(at)
  assert.equal(container.querySelector('time')!.textContent, `ChatTime.today ${clock}`)
})

test('Reply puts the whole message in the composer as a quote', async () => {
  const quoted: string[] = []
  await act(async () => root.render(<ReplyActions copyText={'第一段\n\n第二段'} onQuote={text => { quoted.push(text) }} />))
  await act(async () => { reply()!.click() })
  assert.deepEqual(quoted, ['第一段\n\n第二段'])
})

test('without a way to quote there is no Reply, and an unknown time shows none', async () => {
  await act(async () => root.render(<ReplyActions at={Number.NaN} copyText="read only" />))
  assert.equal(reply(), null)
  assert.equal(container.querySelector('time'), null)
  for (const at of [0, undefined]) {
    await act(async () => root.render(<ReplyActions at={at} copyText="read only" />))
    assert.equal(container.querySelector('time'), null, `no time for ${at}`)
  }
  assert.ok(container.querySelector('button[aria-label="AiElements.message.copy"]'))
})

test('Reply quotes the whole message, cut like a selection so a long reply never blocks the send', async () => {
  const quoted: string[] = []
  const long = 'a'.repeat(1_500)
  await act(async () => root.render(<ReplyActions copyText="newest words" quoteText={'first reply\n\nnewest words'} onQuote={text => { quoted.push(text) }} />))
  await act(async () => { reply()!.click() })
  await act(async () => root.render(<ReplyActions copyText={long} onQuote={text => { quoted.push(text) }} />))
  await act(async () => { reply()!.click() })
  assert.equal(quoted[0], 'first reply\n\nnewest words', 'Reply takes every reply of the message, not only the newest Copy copies')
  assert.equal(quoted[1].length, 1_001)
  assert.ok(quoted[1].endsWith('…'))
})

test('every line waits for hover or focus, is always there on touch, and keeps its space at rest (decision 2026-11-22-1500)', async () => {
  await act(async () => root.render(<ReplyActions copyText="x" onQuote={() => {}} />))
  const classes = container.querySelector('[data-slot="message-actions"]')!.className.split(' ')
  for (const name of ['opacity-0', 'group-hover/message:opacity-100', 'focus-within:opacity-100', 'pointer-coarse:opacity-100'])
    assert.ok(classes.includes(name), name)
  assert.ok(!classes.some(name => /^(hidden|invisible|h-0)$|:hidden$|:invisible$/.test(name)), 'only the opacity changes, so the row keeps its space')
})

test('Edit and Regenerate sit beside Copy as icons, with the version pager before Reply, and only where the caller offers them (decision 2026-11-22-1700)', async () => {
  const pressed: string[] = []
  await act(async () => root.render(<ReplyActions copyText="the reply" onQuote={() => {}} versions={<span data-pager="" />}
    onEdit={() => pressed.push('edit')} onRegenerate={() => pressed.push('regenerate')} />))
  const line = container.querySelector('[data-slot="message-actions"]')!
  const order = [...line.children].map(child => child.getAttribute('aria-label') ?? (child.hasAttribute('data-pager') ? 'pager' : child.tagName))
  assert.deepEqual(order, ['pager', 'AiElements.message.reply', 'AiElements.message.copy', 'AiElements.message.edit', 'AiElements.message.regenerate'])
  for (const name of ['edit', 'regenerate']) {
    const button = container.querySelector(`button[aria-label="AiElements.message.${name}"]`) as HTMLButtonElement
    assert.ok(button.querySelector('svg'), `${name} is an icon`)
    await act(async () => button.click())
  }
  assert.deepEqual(pressed, ['edit', 'regenerate'])
  await act(async () => root.render(<ReplyActions copyText="the reply" />))
  assert.equal(container.querySelector('button[aria-label="AiElements.message.edit"], button[aria-label="AiElements.message.regenerate"]'), null)
  assert.match(line.className, /group-hover\/message:opacity-100/, 'the new icons wait for hover like the rest of the line')
})
