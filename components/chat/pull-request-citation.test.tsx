import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { CitationSource } from '@/lib/coordinator/citations'

mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en', useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
} })
mock.module(new URL('../../app/actions/link-preview.ts', import.meta.url).href, { namedExports: { getLinkPreview: async () => null, getLinkPreviews: async () => ({}) } })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let citations: typeof import('@/components/workspace/agent-citations')

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  citations = await import('@/components/workspace/agent-citations')
})
beforeEach(() => { container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())

const url = 'https://github.com/alexj11324/Mikka/pull/2837'
const issue = { kind: 'issue', id: 'i1', number: 1, identifier: 'MIK-1', title: 'Task', status: 'review', priority: 'none',
  pullRequests: [{ url, state: 'open' }], review: { pr: { number: 2837, url, state: 'open' }, checks: { passed: 3, failed: 0, pending: 2 } } } as unknown as CitationSource

test('a PR link in a reply is a PR chip coloured by the state the chat already read; one it cannot place has no colour (#2922)', async () => {
  const { AgentCitationsContext, WebCitation } = citations
  await act(async () => root.render(<AgentCitationsContext value={{ sources: { i1: issue }, previews: {}, onOpenIssue: () => {} }}>
    <WebCitation url={url} label={null} />
    <WebCitation url={url.replace('2837', '9')} label={null} />
    <WebCitation url="https://github.com/alexj11324/Mikka/issues/5" label={null} />
  </AgentCitationsContext>))
  const chips = [...container.querySelectorAll('a[data-pull-chip]')]
  assert.deepEqual(chips.map(chip => [chip.textContent, chip.getAttribute('data-pull-chip')]), [['Mikka#2837', 'pending'], ['Mikka#9', '']])
  assert.match(chips[0].querySelector('svg')!.getAttribute('class') ?? '', /text-warning-foreground/)
  assert.equal(container.querySelectorAll('a[data-pull-chip]').length, 2, 'a GitHub issue keeps its link citation')
})
