import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'

// Alex, 2026-11-22: as Claude, ChatGPT and Cursor, an opened tool call shows its whole output. The Bot chat's rows
// carry a 200-character preview; the whole call is read only when the row is opened, never for a closed row.
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'zh-CN',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
} })
mock.module('@/components/agents/file-diff', { namedExports: { FileDiff: () => null } })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadToolDetails: typeof import('./thread-tool-details')['ThreadToolDetails']

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadToolDetails } = await import('./thread-tool-details'))
})
after(() => browser.close())

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }

test('a closed row reads nothing; opened, it reads the whole call once and shows it in place of the preview', async () => {
  const whole = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i}`).join('\n')
  const loads: string[] = []
  // The template's row: a native <details> whose body React mounts while it is closed.
  const details = browser.document.createElement('details')
  details.appendChild(browser.document.createElement('summary')).textContent = 'Read file'
  const container = details.appendChild(browser.document.createElement('div'))
  browser.document.body.appendChild(details)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => root.render(<ThreadToolDetails kind="read" target="lib/a.ts" input='{"path": "lib/a.ts"}' output={whole.slice(0, 200)} truncated status="done"
    full={{ key: 'bot:3:read-1', load: async () => { loads.push('read-1'); return { input: '{"path": "lib/a.ts"}', output: whole } } }} />))
  await settle()
  assert.deepEqual(loads, [], 'a closed row does not read the call')
  assert.doesNotMatch(container.textContent ?? '', /line39/)

  await act(async () => { details.open = true; details.dispatchEvent(new browser.Event('toggle')) })
  await settle()
  assert.deepEqual(loads, ['read-1'])
  assert.match(container.textContent ?? '', /line39/, 'the whole file shows once read')
  assert.doesNotMatch(container.textContent ?? '', /Coordinator\.activity\.card\.truncated/, 'a whole output is not marked cut')
  await act(async () => root.unmount())
})

test('a call cut at the bound says so', async () => {
  const container = browser.document.createElement('div')
  browser.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => root.render(<ThreadToolDetails kind="other" output="short" status="done"
    full={{ key: 'bot:3:big', load: async () => ({ output: 'x'.repeat(100), outputCut: true }) }} />))
  await settle()
  assert.match(container.textContent ?? '', /Coordinator\.activity\.card\.truncated/)
  await act(async () => root.unmount())
})
