import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import type { ChatItem } from '@/lib/coordinator/context'
import type { ThreadEntry } from '@/components/slots/thread-contract'

mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => 'en',
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
} })
mock.module('@/app/actions/coordinator', { namedExports: { coordinatorTurnVersions: async () => ({}), reviseCoordinatorTurn: async () => ({ queued: true }) } })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let revision: typeof import('./use-turn-revision')
let editor: typeof import('@/components/chat/message-revision')
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  revision = await import('./use-turn-revision')
  editor = await import('@/components/chat/message-revision')
})
after(() => browser.happyDOM.close())

const item = (position: number, from: ChatItem['from'], text: string, extra: Partial<ChatItem> = {}): ChatItem =>
  ({ position, from, text, tools: [], threads: [], artifacts: [], createdAt: '2026-11-22T10:00:00Z', ...(from === 'person' ? { submissionId: `s${position}` } : {}), ...extra })

test('only the latest turn of words alone can be edited or regenerated', () => {
  const plain = [item(1, 'person', 'Hi'), item(2, 'coordinator', 'Hello'), item(3, 'person', 'Say it simply'), item(4, 'coordinator', 'A box.')]
  assert.deepEqual(revision.revisableTurn(plain), { person: plain[2], reply: plain[3] })
  assert.deepEqual(revision.revisableTurn(plain.slice(0, 3)), { person: plain[2], reply: null }, 'an unanswered message can still be edited')
  for (const [why, changed] of [
    ['a tool ran', { tools: ['create_task'] }], ['a thread was dispatched', { threads: ['r1'] }], ['an artifact was shown', { artifacts: ['a1'] }],
  ] as [string, Partial<ChatItem>][]) assert.equal(revision.revisableTurn([...plain.slice(0, 3), item(4, 'coordinator', 'Done', changed)]), null, why)
  assert.equal(revision.revisableTurn([...plain, item(5, 'event', '')]), null, 'an event after the reply')
  for (const [why, changed] of [
    ['still sending', { pending: true as const }], ['photos', { images: 1 }], ['a 建议 card', { suggestion: { source: 'gmail' } as never }],
    ['an artifact quote', { quote: { artifactId: 'a' } as never }], ['no submission', { submissionId: undefined }],
  ] as const) assert.equal(revision.revisableTurn([plain[0]!, plain[1]!, item(3, 'person', 'Again', changed)]), null, why)
})

test('an earlier version replaces the live turn’s words and replies, and keeps the person’s line', () => {
  const entries: ThreadEntry[] = [
    { id: '1', role: 'person', at: 1, text: 'Hi' },
    { id: '2', role: 'bot', at: 2, parts: [{ kind: 'text', text: 'Hello', node: null }] },
    { id: '3', role: 'person', at: 3, text: 'Explain it to a child', body: 'linked', actions: 'line' },
    { id: '4', role: 'bot', at: 4, parts: [{ kind: 'text', text: 'Something you can chain.', node: null }] },
    { id: '5', role: 'bot', at: 5, event: true, parts: [{ kind: 'text', text: '', node: null }] },
  ]
  const shown = revision.showTurnVersion(entries, { person: '3', replies: ['4'], submissionId: 's3' }, { person: 'Say it simply', reply: 'A box.', at: '' },
    text => [{ kind: 'text', text, node: null }])
  assert.deepEqual(shown.map(entry => entry.id), ['1', '2', '3', '3-version', '5'])
  assert.deepEqual(shown[2], { id: '3', role: 'person', at: 3, text: 'Say it simply', body: undefined, attachments: undefined, actions: 'line' })
  assert.deepEqual(shown[3], { id: '3-version', role: 'bot', at: 4, parts: [{ kind: 'text', text: 'A box.', node: null }] })
})

test('the editor sends only changed words, cancels on Escape, and the pager pages', async () => {
  const { createRoot } = await import('react-dom/client')
  const container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  const root = createRoot(container)
  const sent: string[] = []
  let cancelled = 0
  await act(async () => root.render(<editor.MessageEditor text="Say it simply" busy={false} onCancel={() => { cancelled++ }} onSend={text => sent.push(text)} />))
  const field = container.querySelector('textarea')!
  const send = [...container.querySelectorAll('button')].find(button => button.textContent === 'AiElements.message.editSend')!
  assert.equal(field.getAttribute('aria-label'), 'AiElements.message.editLabel')
  assert.equal(send.disabled, true, 'unchanged words do not resend the turn')
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  await act(async () => { setter.call(field, '  Explain it to a child  '); field.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event) })
  assert.equal(send.disabled, false)
  await act(async () => send.click())
  assert.deepEqual(sent, ['Explain it to a child'])
  await act(async () => { field.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event) })
  assert.equal(cancelled, 1)
  const pages: number[] = []
  await act(async () => root.render(<editor.VersionPager index={1} total={2} onChange={index => pages.push(index)} />))
  const [previous, next] = [...container.querySelectorAll('button')]
  assert.equal(container.textContent, 'AiElements.message.versionPosition')
  assert.equal(next!.disabled, true, 'the newest version is the last')
  await act(async () => previous!.click())
  assert.deepEqual(pages, [0])
  await act(async () => root.unmount())
})
