import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// The jump index on a screen that mounts only the rows near the view (the official thread's virtual list): a row off
// screen is not in the document, so the index asks the screen to reveal it; on a screen that mounts every row, it
// scrolls to the row in the document.
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
} })
// The popover's content stands open here: the rows are what this test presses
mock.module('@/components/ui/popover', { namedExports: {
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
} })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadOutlineIndex: typeof import('./thread-outline-index')['ThreadOutlineIndex']

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, CSS: { escape: (value: string) => value } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadOutlineIndex } = await import('./thread-outline-index'))
})
beforeEach(() => {
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  browser.document.body.append(container as never)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

const entries = [
  { id: 'a', author: 'Ann', text: 'First question', at: 1, mine: false },
  { id: 'b', author: 'Ben', text: 'Second question', at: 2, mine: true },
]
const press = async (text: string) => {
  const row = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(text))
  assert.ok(row, text)
  await act(async () => { row.click() })
}

test('a row off screen is the screen\'s to reveal', async () => {
  const asked: string[] = []
  await act(async () => root.render(<ThreadOutlineIndex entries={entries} onReveal={id => { asked.push(id); return true }} />))
  await press('Second question')
  assert.deepEqual(asked, ['b'])
})

test('a screen with every row mounted: the row in the document scrolls into view', async () => {
  const scrolled: string[] = []
  const row = browser.document.createElement('span')
  row.setAttribute('data-thread-item', 'a')
  row.scrollIntoView = () => { scrolled.push('a') }
  browser.document.body.append(row)
  await act(async () => root.render(<ThreadOutlineIndex entries={entries} onReveal={() => false} />))
  await press('First question')
  assert.deepEqual(scrolled, ['a'])
  row.remove()
})
