import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { unstable_serialize, type Cache } from 'swr'
import chinese from '../../messages/zh-CN.json'
import english from '../../messages/en.json'

// One chat-shaped loading state, held back for 200ms; a Bot switch that keeps the chat on screen until the next
// one's first read lands; that read started from a sidebar row; and the window's title naming the chat
// (UX audit 2026-11-22 #3, #4).

let locale: 'en' | 'zh-CN' = 'en'
const messages = () => locale === 'en' ? english : chinese
const lookup = (path: string, values?: Record<string, unknown>) => {
  const text = path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], messages()) as string
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`))
}
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useLocale: () => locale, useMessages: messages,
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => lookup(`${namespace}.${key}`, values),
} })
const chatReads: (string | null)[] = []
mock.module('@/lib/coordinator/chat-read-client', { namedExports: {
  readCachedCoordinatorChat: async (_cache: Cache, botId: string | null) => { chatReads.push(botId); return { botId, items: [] } },
} })
mock.module('@/components/coordinator/coordinator-chat', { namedExports: { CoordinatorChat: () => null } })
mock.module('@/lib/swr/persistent-cache', { namedExports: {
  PersistentReadCache: class {}, readAccessFailure: () => false, waitForCacheHydration: async () => {},
} })

const browser = new Window({ url: 'https://fixture.example/' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let loading: typeof import('./workspace-loading')
let hold: typeof import('./chat-hold')
let title: typeof import('./document-title')
let loaders: typeof import('./page-loaders')
let delay: typeof import('@/lib/hooks/use-delayed-visible')

before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  loading = await import('./workspace-loading')
  hold = await import('./chat-hold')
  title = await import('./document-title')
  loaders = await import('./page-loaders')
  delay = await import('@/lib/hooks/use-delayed-visible')
})
beforeEach(() => {
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
after(() => browser.close())

const wait = (ms: number) => act(() => new Promise<void>(resolve => setTimeout(resolve, ms)))
const skeleton = () => container.querySelector('[data-chat-skeleton]')
const status = () => container.querySelector('[role="status"][aria-busy="true"]')
/** Long enough after any earlier skeleton that a new one is not a hand-over. */
const settle = () => wait(delay.SKELETON_HANDOVER_MS + 20)

test('a chat\'s skeleton paints only once its wait passes 200ms; until then the pane says it is loading and draws nothing', async () => {
  await settle()
  await act(async () => root.render(<loading.ConversationPageLoading />))
  assert.ok(status(), 'the loading state is announced at once')
  assert.equal(skeleton(), null, 'no skeleton for a wait shorter than 200ms')
  await wait(120)
  assert.equal(skeleton(), null)
  await wait(delay.SKELETON_DELAY_MS)
  assert.ok(skeleton(), 'the skeleton after 200ms')
  assert.ok(skeleton()?.querySelectorAll('[data-slot="skeleton"]').length, 'bubbles and the composer')
})

test('a skeleton that takes over from one on screen paints at once, and one that follows a waiting one keeps its wait', async () => {
  await settle()
  function Owners() {
    const [owner, setOwner] = useState(0)
    swap = () => setOwner(value => value + 1)
    // Each owner is its own copy of the same skeleton: the app's first paint, the chat's chunk, its first read.
    return <loading.ConversationPageLoading key={owner} />
  }
  let swap = () => {}
  await act(async () => root.render(<Owners />))
  await wait(120)
  await act(async () => swap())
  assert.equal(skeleton(), null, 'a hand-over inside the wait does not paint early')
  await wait(110)
  assert.ok(skeleton(), 'and does not start the 200ms again')
  await act(async () => swap())
  assert.ok(skeleton(), 'a hand-over from a skeleton on screen never blanks the pane')
  // The official thread screen draws its own copy in CSS before its first read; it reads the hand-over from <html>.
  assert.equal(document.documentElement.hasAttribute('data-chat-skeleton'), true)
  await act(async () => root.render(<></>))
  assert.equal(document.documentElement.hasAttribute('data-chat-skeleton'), true, 'still a hand-over just after')
  await settle()
  assert.equal(document.documentElement.hasAttribute('data-chat-skeleton'), true, 'kept a while longer for a screen styled late')
  await wait(1_000)
  assert.equal(document.documentElement.hasAttribute('data-chat-skeleton'), false)
})

test('the first paint of an address that opens a chat is the chat\'s skeleton, not a page of blocks', async () => {
  assert.equal(loading.opensChat({ pathname: '/', search: '' }), true, 'the home is the Coordinator\'s chat')
  assert.equal(loading.opensChat({ pathname: '/', search: '?bot=3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f' }), true)
  assert.equal(loading.opensChat({ pathname: '/zh-CN', search: '?group=3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f' }), true)
  assert.equal(loading.opensChat({ pathname: '/', search: '?mainThread=3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f' }), true)
  assert.equal(loading.opensChat({ pathname: '/', search: '?issue=3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f' }), false, 'a task opens its own page')
  assert.equal(loading.opensChat({ pathname: '/', search: '?section=all-issues' }), false)
  assert.equal(loading.opensChat({ pathname: '/settings', search: '' }), false)

  await settle()
  browser.history.replaceState({}, '', '/?bot=3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f')
  await act(async () => root.render(<loading.WorkspaceLoading />))
  await wait(delay.SKELETON_DELAY_MS + 20)
  assert.ok(container.querySelector('main [data-chat-skeleton]'))
  await act(async () => root.render(<></>))
  await settle()
  browser.history.replaceState({}, '', '/?section=all-issues')
  await act(async () => root.render(<loading.WorkspaceLoading />))
  await wait(delay.SKELETON_DELAY_MS + 20)
  assert.equal(container.querySelector('[data-chat-skeleton]'), null)
  assert.ok(container.querySelector('main [role="status"]'))
  browser.history.replaceState({}, '', '/')
})

type Chat = { id: string; name: string } | undefined
const ada = { id: 'ada', name: 'Ada' }, grace = { id: 'grace', name: 'Grace' }

/** The centre as issue-workspace draws it: the held chat's transcript, keyed by its Bot. */
function Centre({ next, active = true, ready, load, holdMs }: { next: Chat; active?: boolean; ready: (chat: Chat) => boolean; load: (chat: Chat) => Promise<unknown>; holdMs?: number }) {
  const shown = hold.useChatHold(next, { active, key: chat => chat?.id ?? 'coordinator', ready, load, holdMs })
  return <section data-shown={shown?.name ?? 'Coordinator'} />
}
const shownChat = () => container.querySelector('section')?.getAttribute('data-shown')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

test('switching Bots keeps the chat on screen until the next one\'s first read lands, then shows it in one step', async () => {
  const read = deferred()
  const asked: Chat[] = []
  const load = (chat: Chat) => { asked.push(chat); return read.promise }
  await act(async () => root.render(<Centre next={ada} ready={() => false} load={load} />))
  assert.equal(shownChat(), 'Ada', 'the first open holds nothing: there is no chat to keep')
  assert.deepEqual(asked, [])

  await act(async () => root.render(<Centre next={grace} ready={() => false} load={load} />))
  assert.equal(shownChat(), 'Ada', 'the chat on screen stays while the next one reads')
  assert.deepEqual(asked, [grace], 'the next chat\'s own read is started once')
  await act(async () => { read.resolve(); await read.promise })
  assert.equal(shownChat(), 'Grace')
})

test('a chat already read opens at once, and a page between two chats keeps nothing', async () => {
  const read = deferred()
  let loads = 0
  const load = () => { loads++; return read.promise }
  await act(async () => root.render(<Centre next={ada} ready={chat => chat?.id === 'grace'} load={load} />))
  await act(async () => root.render(<Centre next={grace} ready={chat => chat?.id === 'grace'} load={load} />))
  assert.equal(shownChat(), 'Grace', 'cached or prefetched: no hold')
  await act(async () => root.render(<Centre next={undefined} active={false} ready={() => false} load={load} />))
  await act(async () => root.render(<Centre next={ada} ready={() => false} load={load} />))
  assert.equal(shownChat(), 'Ada', 'coming back from another page there is no previous chat to hold')
  assert.equal(loads, 0)
})

test('a slow first read gives up the hold after its limit, and a later choice wins over an earlier one', async () => {
  const slow = deferred()
  await act(async () => root.render(<Centre next={ada} ready={() => false} load={() => slow.promise} holdMs={60} />))
  await act(async () => root.render(<Centre next={grace} ready={() => false} load={() => slow.promise} holdMs={60} />))
  assert.equal(shownChat(), 'Ada')
  await wait(80)
  assert.equal(shownChat(), 'Grace', 'the next chat opens on its own skeleton instead of waiting on')

  const first = deferred(), second = deferred()
  const reads = new Map<string, Promise<void>>([['ada', first.promise], ['coordinator', second.promise]])
  const load = (chat: Chat) => reads.get(chat?.id ?? 'coordinator')!
  await act(async () => root.render(<Centre next={ada} ready={() => false} load={load} />))
  await act(async () => root.render(<Centre next={undefined} ready={() => false} load={load} />))
  await act(async () => { first.resolve(); await first.promise })
  assert.equal(shownChat(), 'Grace', 'a read for a chat the person already left opens nothing')
  await act(async () => { second.resolve(); await second.promise })
  assert.equal(shownChat(), 'Coordinator')
  slow.resolve()
})

test('pointing at a Bot\'s row reads its chat into the cache with the chat\'s own reader, once; the page alone reads nothing', async () => {
  chatReads.length = 0
  const cache = new Map() as unknown as Cache
  const writes: import('swr').Key[] = []
  const mutate = (async (key: import('swr').Key, value: unknown) => { writes.push(key); (cache as unknown as Map<string, unknown>).set(unstable_serialize(key), { data: value }) }) as never
  const scope = { cache, mutate, workspaceId: 'workspace-one' }
  await loaders.preloadWorkspacePage('coordinator', scope)
  assert.deepEqual(chatReads, [], 'no target, no read')
  await Promise.all([
    loaders.preloadWorkspacePage('coordinator', scope, { kind: 'bot', botId: 'ada' }),
    loaders.preloadWorkspacePage('coordinator', scope, { kind: 'bot', botId: 'ada' }),
  ])
  await loaders.preloadWorkspacePage('coordinator', scope, { kind: 'bot', botId: 'ada' })
  await loaders.preloadWorkspacePage('coordinator', scope, { kind: 'coordinator' })
  assert.deepEqual(chatReads, ['ada', null], 'a second hover on a chat in hand reads nothing')
  assert.deepEqual(writes.map(key => unstable_serialize(key)), [unstable_serialize(['coordinator-chat', 'ada']), 'coordinator-chat'], 'under the keys the chat reads')
})

test('the window\'s title names the chat, the group or the thread, then Mikka; anything else is Mikka', async () => {
  function Title({ name }: { name: string | null }) { title.useDocumentTitle(name); return null }
  for (const language of ['en', 'zh-CN'] as const) {
    locale = language
    await act(async () => root.render(<Title name="工程 Bot" />))
    assert.equal(document.title, '工程 Bot · Mikka')
    await act(async () => root.render(<Title name="  " />))
    assert.equal(document.title, 'Mikka', 'a name not loaded yet')
    await act(async () => root.render(<Title name={null} />))
    assert.equal(document.title, 'Mikka')
  }
  locale = 'en'
})
