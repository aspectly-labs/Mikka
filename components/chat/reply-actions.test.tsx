import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
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
  const at = Date.UTC(2026, 10, 19, 14, 41)
  await act(async () => root.render(<ReplyActions at={at} copyText="the reply" onQuote={() => {}}><span data-extra="" /></ReplyActions>))
  const line = container.querySelector('[data-slot="reply-actions"]')!
  const time = line.querySelector('time')!
  assert.equal(time.getAttribute('datetime'), new Date(at).toISOString())
  assert.equal(time.textContent, `at:${new Date(at).toISOString()}`)
  const order = [...line.children].map(child => child.tagName === 'TIME' ? 'time' : child.getAttribute('aria-label') ?? (child.hasAttribute('data-extra') ? 'extra' : child.tagName))
  assert.deepEqual(order, ['time', 'AiElements.message.reply', 'AiElements.message.copy', 'extra'])
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
